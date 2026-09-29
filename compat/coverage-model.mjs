// Coverage model foundation (issues/open/20260929-cloudflare-feature-
// coverage-automation.md, phases 1). Single import surface for:
//
//   - profile taxonomy + lifecycle (compat/inventory/discovery-roots.json)
//   - oracle-specific coverage states + probe-verdict → state reduction
//   - evidence freshness: the relevant-input hash bundle that decides whether
//     recorded evidence is still valid (STALE) for the current run
//
// Everything here is a pure function over committed inputs; run-time code
// calls loadDiscoverySpec() once and passes the result through.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const ORACLES = ["pinned", "latest", "hosted"];

// Per-probe verdict for one oracle run (issue §4).
export const PROBE_VERDICTS = ["VERIFIED", "DIVERGENT", "BLOCKED", "UNTESTED", "STALE"];
// Requirement/capability states add the declared UNSUPPORTED state (issue §5).
export const COVERAGE_STATES = ["VERIFIED", "DIVERGENT", "UNSUPPORTED", "UNTESTED", "BLOCKED", "STALE"];

export const PROFILE_LIFECYCLES = ["active", "deferred"];

// ── Discovery spec ─────────────────────────────────────────────────────────

export function loadDiscoverySpec(inventoryDir) {
  const spec = JSON.parse(readFileSync(join(inventoryDir, "discovery-roots.json"), "utf8"));
  validateDiscoverySpec(spec);
  return spec;
}

export function validateDiscoverySpec(spec) {
  if (spec?.formatVersion !== 1) throw new Error("discovery-roots.json: unsupported formatVersion");
  const profiles = spec.profiles ?? {};
  const order = spec.profileOrder ?? [];
  for (const name of order) {
    const profile = profiles[name];
    if (!profile) throw new Error("discovery-roots.json: profileOrder entry has no profile: " + name);
    if (!PROFILE_LIFECYCLES.includes(profile.lifecycle)) {
      throw new Error("discovery-roots.json: profile " + name + " has unknown lifecycle " + JSON.stringify(profile.lifecycle));
    }
  }
  for (const name of Object.keys(profiles)) {
    if (!order.includes(name)) throw new Error("discovery-roots.json: profile missing from profileOrder: " + name);
  }
  for (const [name, roots] of Object.entries(spec.roots ?? {})) {
    if (!profiles[name]) throw new Error("discovery-roots.json: roots declared for undefined profile " + name);
    for (const root of roots.workersTypes ?? []) {
      if (typeof root.container !== "string" || !Array.isArray(root.names)) {
        throw new Error("discovery-roots.json: malformed workersTypes root for " + name + ": " + JSON.stringify(root));
      }
    }
    if (!Array.isArray(roots.wranglerSchema ?? [])) {
      throw new Error("discovery-roots.json: malformed wranglerSchema roots for " + name);
    }
  }
  return spec;
}

export function activeProfiles(spec) {
  return (spec.profileOrder ?? []).filter((name) => spec.profiles[name]?.lifecycle === "active");
}

// ── Probe verdict → requirement/capability state ───────────────────────────
//
// Deterministic reduction (issue §4): first match wins.
//   declared unsupported → UNSUPPORTED
//   any DIVERGENT        → DIVERGENT
//   any BLOCKED          → BLOCKED
//   any STALE            → STALE
//   any UNTESTED/absent  → UNTESTED
//   all VERIFIED         → VERIFIED
// A requirement with zero probe verdicts cannot be VERIFIED → UNTESTED.
export function reduceProbeVerdicts(verdicts, { declaredUnsupported = false } = {}) {
  if (declaredUnsupported) return "UNSUPPORTED";
  for (const state of ["DIVERGENT", "BLOCKED", "STALE", "UNTESTED"]) {
    if (verdicts.includes(state)) return state;
  }
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "VERIFIED")) return "VERIFIED";
  return "UNTESTED";
}

export function reduceRequirementStates(states, { declaredUnsupported = false } = {}) {
  return reduceProbeVerdicts(states, { declaredUnsupported });
}

// ── Evidence freshness ─────────────────────────────────────────────────────
//
// declaredSupport        — human/agent declared support flags (legacy
//                          capabilities.json evidence), never feeds VERIFIED
// lastVerifiedEvidence   — {runId, oracle, relevantInputHash} of the last run
//                          whose evidence still matches current inputs
// currentRunStatus       — what this run observed, always oracle-specific
//
// Freshness equality key = the relevant-input hash bundle below. The git
// commit SHA is provenance, not a freshness key (issue §7): unrelated doc or
// test commits must not invalidate evidence.
export const EVIDENCE_ROLES = ["declaredSupport", "lastVerifiedEvidence", "currentRunStatus"];

export function sha256Text(text) {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function sha256File(path) {
  return sha256Text(readFileSync(path));
}

// Deterministic hash of a set of files keyed by their sorted relative paths.
export function hashFiles(rootDir, paths) {
  const relPaths = paths.map((path) => relative(rootDir, path)).sort();
  const parts = relPaths.map((rel) => rel + "\n" + readFileSync(join(rootDir, rel), "utf8"));
  return sha256Text(parts.join("\n---\n"));
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFilesRecursive(path));
    else out.push(path);
  }
  return out.sort();
}

// Canonical hash of the resolved upstream dependency graph — the runtime
// wrangler actually starts (miniflare/workerd/esbuild/unenv...). candidate.id
// intentionally excludes this, so coverage candidate identity is computed
// here (issue §7): a transitive-graph change invalidates old evidence even
// when the top-level pin tuple is unchanged.
export function dependencyGraphHash(candidate) {
  const graph = candidate?.dependencyGraph ?? {};
  const canonical = Object.keys(graph).sort().map((name) => name + "@" + graph[name]);
  return sha256Text(canonical.join("\n"));
}

export function candidateIdentity(candidate) {
  return {
    id: candidate?.id ?? null,
    versions: candidate?.versions ?? null,
    dependencyGraphHash: dependencyGraphHash(candidate),
  };
}

// The relevant-input hash bundle for one oracle run (issue §7). Paths are
// repo-root-relative so the bundle is comparable across runs/machines.
export function computeRelevantInputs(rootDir, candidate, { inventoryDir = "compat/inventory" } = {}) {
  const implementationPaths = ["host", "src", "compat/cloudflare-workers", "scripts/build-core.mjs"]
    .flatMap((segment) => {
      const path = join(rootDir, segment);
      return existsSync(path) ? (statSync(path).isDirectory() ? listFilesRecursive(path) : [path]) : [];
    });
  const probeSourcePaths = listFilesRecursive(join(rootDir, "compat/probes/src"));
  const comparisonPaths = ["compat/normalize.mjs", "compat/probe-client.mjs"].map((p) => join(rootDir, p));
  const inventoryPaths = listFilesRecursive(join(rootDir, inventoryDir)).filter((path) => path.endsWith(".json"));
  const configPaths = ["compat/probes/wrangler.jsonc", "fixtures/e2e/workflows.mbt.json"]
    .map((p) => join(rootDir, p))
    .filter((path) => existsSync(path));
  const conditions = candidate?.conditions ?? {};
  return {
    implementationSourceHash: hashFiles(rootDir, implementationPaths),
    probeSourceHash: hashFiles(rootDir, probeSourcePaths),
    catalogHash: sha256File(join(rootDir, "compat/probes/catalog.json")),
    comparisonHash: hashFiles(rootDir, comparisonPaths),
    inventoryHash: hashFiles(rootDir, inventoryPaths),
    capabilityHash: sha256File(join(rootDir, "compat/capabilities.json")),
    configHash: hashFiles(rootDir, configPaths),
    upstreamCandidate: candidateIdentity(candidate),
    compatibilityDate: conditions.probesCompatibilityDate ?? conditions.compatibilityDate ?? null,
    compatibilityFlags: conditions.compatibilityFlags ?? [],
  };
}

// Run-result fingerprint embedded in generated result files (issue §7
// "Run result fingerprint"). `commit` is recorded as provenance and is
// deliberately absent from the freshness equality key.
export function buildResultFingerprint({ runId, oracle, candidate, relevantInputs, commit }) {
  return {
    schemaVersion: 1,
    oracle,
    runId,
    runTimestamp: new Date().toISOString(),
    commit: commit ?? null, // provenance only — NOT a freshness key
    upstreamCandidate: candidateIdentity(candidate),
    compatibilityDate: relevantInputs.compatibilityDate,
    compatibilityFlags: relevantInputs.compatibilityFlags,
    relevantInputs: {
      implementationSourceHash: relevantInputs.implementationSourceHash,
      probeSourceHash: relevantInputs.probeSourceHash,
      catalogHash: relevantInputs.catalogHash,
      comparisonHash: relevantInputs.comparisonHash,
      inventoryHash: relevantInputs.inventoryHash,
      capabilityHash: relevantInputs.capabilityHash,
      configHash: relevantInputs.configHash,
    },
  };
}

// Evidence is fresh only when every relevant-input key still matches —
// a differing commit alone never makes evidence STALE.
export function evidenceIsStale(recorded, current) {
  if (!recorded || !current) return true;
  for (const [key, now] of Object.entries(current)) {
    if (JSON.stringify(recorded[key]) !== JSON.stringify(now)) return true;
  }
  return false;
}
