import { differentialProbes } from "./candidate-policy.mjs";
// Validates compat/capabilities.json (formatVersion 2) against the probe
// catalog, the resolved inventory (baselines ⋈ classification), and the
// differential results actually produced.
//
//   node compat/check-capabilities.mjs [--require-pinned] [--require-latest] [--require-hosted]
//
// Checks (issue 20260929 §3, §10):
//   1. capabilities.json ↔ probes catalog ↔ compat-results three-way
//      consistency (result files are read as oracle-specific evidence);
//   2. capabilities ↔ requirements ↔ probes chain integrity — requirements
//      are the canonical counting unit, defined once in requirements[];
//   3. capability ↔ profile ↔ upstream-item profile consistency — every
//      upstream ref must exist in the committed inventory and classify to
//      the capability's own profile;
//   4. requirement scope derivation — no upstreamRefs requires an explicit
//      target; declared targets may not contradict the derivation.
//
// declaredSupport flags are declared (legacy-unverified) evidence: they are
// checked against result files so the ledger cannot claim coverage a run did
// not deliver, but they never determine verification state by themselves.
// In-scope inventory items that no requirement references are reported as
// coverage gaps (non-fatal — they are the discovery backlog).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";
import {
  ORACLES,
  activeProfiles,
  currentFreshnessInputs,
  deriveRequirementTarget,
  fingerprintIsStale,
  loadDiscoverySpec,
  probeVerdictFor,
  reduceProbeVerdicts,
} from "./coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
const inventoryDir = process.env.WORKFLOWS_MBT_INVENTORY_DIR
  ? resolve(process.env.WORKFLOWS_MBT_INVENTORY_DIR)
  : join(root, "compat/inventory");
const requiredOracles = ["pinned", "latest", "hosted"]
  .filter((oracle) => process.argv.includes("--require-" + oracle));

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const matrixPath = process.env.WORKFLOWS_MBT_CAPABILITIES
  ? resolve(process.env.WORKFLOWS_MBT_CAPABILITIES)
  : join(root, "compat/capabilities.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

const spec = loadDiscoverySpec(inventoryDir);
const active = new Set(activeProfiles(spec));
const classification = JSON.parse(readFileSync(join(inventoryDir, "classification.json"), "utf8"));

function loadResult(name) {
  const path = join(resultsDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
const differential = {
  pinned: loadResult("differential-pinned.json"),
  latest: loadResult("differential-latest.json"),
  hosted: loadResult("differential-hosted.json"),
};
const driftPinned = loadResult("drift-pinned.json");
const driftLatest = loadResult("drift-latest.json");
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

const errors = [];
const notes = [];
const fail = (message) => errors.push(message);

if (matrix.formatVersion !== 2) {
  fail("capabilities.json must be formatVersion 2, got " + JSON.stringify(matrix.formatVersion));
}

// ── Requirement registry ───────────────────────────────────────────────────

const requirementById = new Map();
for (const req of matrix.requirements ?? []) {
  if (!req.id || typeof req.id !== "string") fail("requirement missing id: " + JSON.stringify(req));
  else if (requirementById.has(req.id)) fail("duplicate requirement id: " + req.id);
  else requirementById.set(req.id, req);
  const parts = (req.id ?? "").split(".");
  if (parts[0] !== "req" || parts.length < 4) {
    fail("requirement id must be req.<profile>.<area>.<name>: " + req.id);
  } else if (!active.has(parts[1])) {
    fail(req.id + ": requirement profile must be an active profile, got " + JSON.stringify(parts[1]));
  }
  if (!Array.isArray(req.requiredProbes)) fail(req.id + ": requiredProbes must be an array");
  for (const probeId of req.requiredProbes ?? []) {
    if (!catalog.probes.some((probe) => probe.id === probeId)) {
      fail(req.id + ": requiredProbes lists unknown probe " + probeId);
    }
  }
  if (req.unsupported !== undefined && !req.unsupported?.reason) {
    fail(req.id + ": unsupported must carry a reason");
  }
  const refs = req.upstreamRefs ?? [];
  if (refs.length === 0 && !["in-scope", "excluded"].includes(req.target)) {
    fail(req.id + ": no upstreamRefs — explicit target (in-scope|excluded) required");
  }
  if (req.target === "excluded" && !req.exclusionReason) {
    fail(req.id + ": excluded target requires exclusionReason");
  }
  // Scope derivation: a requirement over upstream refs is in-scope iff any
  // referenced item is in-scope; a declared target may not contradict that.
  for (const ref of refs) {
    if (!classification.items[ref]) fail(req.id + ": upstreamRef not in inventory classification: " + ref);
  }
  if (refs.length > 0 && refs.every((ref) => classification.items[ref])) {
    const derived = deriveRequirementTarget(req, classification.items);
    if (req.target && req.target !== derived) {
      fail(req.id + ": declared target " + req.target + " contradicts derived scope " + derived);
    }
    if (derived === "excluded" && (req.requiredProbes ?? []).length > 0) {
      fail(req.id + ": derives excluded but still claims requiredProbes");
    }
    req.derivedTarget = derived;
  } else if (refs.length === 0) {
    req.derivedTarget = req.target;
  }
}

// ── Capability rows ────────────────────────────────────────────────────────

const capabilityToProbes = new Map();
const capabilityToSkipped = new Map();
for (const probe of catalog.probes) {
  for (const capability of probe.capabilities ?? []) {
    const target = probe.differential === false ? capabilityToSkipped : capabilityToProbes;
    if (!target.has(capability)) target.set(capability, []);
    target.get(capability).push(probe.id);
  }
}

const referencedInventoryIds = new Set();
const rowById = new Map();
for (const row of matrix.capabilities ?? []) {
  if (!row.id || typeof row.id !== "string") fail("capability row missing id: " + JSON.stringify(row));
  if (rowById.has(row.id)) fail("duplicate capability id: " + row.id);
  rowById.set(row.id, row);
  if (!matrix.categories?.includes(row.category)) fail(row.id + ": unknown category " + row.category);
  if (!Array.isArray(row.probes)) fail(row.id + ": probes must be an array");
  if (row.declaredSupport?.intentionally_unsupported && !row.knownDifference) {
    fail(row.id + ": intentionally_unsupported requires a knownDifference note");
  }
  if (row.evidence) {
    fail(row.id + ": legacy evidence block must be named declaredSupport in formatVersion 2");
  }

  // profile + upstream chain
  if (!row.profile) fail(row.id + ": missing profile");
  else if (!spec.profiles[row.profile]) fail(row.id + ": unknown profile " + row.profile);
  else if (!active.has(row.profile)) fail(row.id + ": profile " + row.profile + " is not active");
  const upstreamRefs = [...(row.upstream?.symbols ?? []), ...(row.upstream?.semantic ?? [])];
  if (upstreamRefs.length === 0) fail(row.id + ": no upstream refs — at least one stable inventory ID required");
  for (const ref of upstreamRefs) {
    const cls = classification.items[ref];
    if (!cls) { fail(row.id + ": upstream ref not in inventory: " + ref); continue; }
    if (cls.profile !== row.profile) {
      fail(row.id + ": upstream ref " + ref + " classifies to profile " + cls.profile + " but capability claims " + row.profile);
    }
  }

  // requirement chain: every requirement exists, is owned by this profile,
  // and the union of requiredProbes reproduces row.probes exactly.
  if (!Array.isArray(row.requirements) || row.requirements.length === 0) {
    fail(row.id + ": capabilities must reference at least one requirement");
  }
  const claimedProbes = [];
  for (const reqId of row.requirements ?? []) {
    const req = requirementById.get(reqId);
    if (!req) { fail(row.id + ": unknown requirement " + reqId); continue; }
    if (req.id.split(".")[1] !== row.profile) {
      fail(row.id + ": requirement " + reqId + " belongs to profile " + req.id.split(".")[1] + ", not " + row.profile);
    }
    claimedProbes.push(...(req.requiredProbes ?? []));
    for (const ref of req.upstreamRefs ?? []) referencedInventoryIds.add(ref);
    if (req.derivedTarget === "excluded") {
      fail(row.id + ": references excluded-scope requirement " + reqId);
    }
  }
  if (Array.isArray(row.probes) && Array.isArray(row.requirements)) {
    const expected = [...new Set(claimedProbes)].sort();
    const actual = [...(row.probes ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(row.id + ": probes " + JSON.stringify(actual) + " != union of requirements' requiredProbes " + JSON.stringify(expected));
    }
  }
}

for (const [capability, probes] of capabilityToProbes) {
  const row = rowById.get(capability);
  if (!row) { fail("catalog capability has no matrix row: " + capability); continue; }
  const expected = [...probes].sort();
  const actual = [...(row.probes ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(capability + ": row probes " + JSON.stringify(actual) + " != catalog " + JSON.stringify(expected));
  }
}
for (const [capability, skipped] of capabilityToSkipped) {
  const row = rowById.get(capability);
  if (!row) continue;
  const expected = [...skipped].sort();
  const actual = [...(row.skippedProbes ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(capability + ": row skippedProbes " + JSON.stringify(actual) + " != catalog " + JSON.stringify(expected));
  }
}
for (const row of matrix.capabilities ?? []) {
  for (const probeId of [...(row.probes ?? []), ...(row.skippedProbes ?? [])]) {
    if (!catalog.probes.some((probe) => probe.id === probeId)) {
      fail(row.id + ": lists unknown probe " + probeId);
    }
  }
}

// A differential run must cover the whole differential-eligible catalog; a
// partial/stale file is not evidence for any row.
for (const [oracle, result] of Object.entries(differential)) {
  if (!result) continue;
  const candidate = loadResult("candidate-" + oracle + ".json");
  const catalogDifferentialProbes = differentialProbes(catalog, candidate).sort();
  const covered = [...(result.probes ?? [])].sort();
  if (JSON.stringify(covered) !== JSON.stringify(catalogDifferentialProbes)) {
    fail("differential-" + oracle + ".json covers " + covered.length + "/" + catalogDifferentialProbes.length + " catalog probes — stale or partial result");
  }
}

// Result files are oracle-specific evidence. declaredSupport flags are
// checked against them: a flag may not claim coverage a run did not deliver.
for (const oracle of ["pinned", "latest", "hosted"]) {
  if (requiredOracles.includes(oracle) && !differential[oracle]) {
    fail("differential-" + oracle + ".json missing (--require-" + oracle + " given)");
  }
}
const resolved = [];
for (const row of matrix.capabilities ?? []) {
  const declared = { ...row.declaredSupport };
  for (const oracle of ["pinned", "latest", "hosted"]) {
    const flag = oracle + "_differential";
    const result = differential[oracle];
    if (!result) {
      if (declared[flag] && (row.probes ?? []).length > 0) {
        notes.push(row.id + ": " + flag + " claimed but not re-verified (no result file)");
      }
      continue;
    }
    // A probe counts as clean evidence only when it ran and matched —
    // trace differences and per-probe execution errors both disqualify it.
    const covered =
      (row.probes ?? []).length > 0 &&
      row.probes.every(
        (probe) => result.probes.includes(probe)
          && !result.differences?.[probe]
          && !result.probeErrors?.[probe],
      );
    if (declared[flag] && !covered) {
      fail(row.id + ": claims " + flag + " but differential-" + oracle + " did not pass cleanly for " + JSON.stringify(row.probes ?? []));
    }
    if (!declared[flag] && covered && result.pass) {
      fail(row.id + ": " + flag + " is supported by results but the flag is not set");
    }
  }
  resolved.push(row);
}

// ── Coverage snapshot (derived, per oracle) ────────────────────────────────
// currentRunStatus per requirement = reduction of its required probes'
// verdicts in that oracle's result file. UNSUPPORTED is declared intent
// (requirement.unsupported) and stays in the denominator.

// Freshness of each oracle's result file (issue §7): the run fingerprint's
// relevant-input hashes + candidate identity must match current inputs.
// A missing fingerprint is legacy-unverified; a mismatch is STALE — in both
// cases VERIFIED evidence from that run is downgraded (never counted).
const oracleFreshness = {};
for (const oracle of ORACLES) {
  const result = differential[oracle];
  if (!result) continue;
  const inputs = currentFreshnessInputs(root, resultsDir, oracle, { inventoryDir });
  const stale = fingerprintIsStale(result.fingerprint, inputs);
  oracleFreshness[oracle] = stale ? "stale" : "fresh";
  if (stale) {
    notes.push("differential-" + oracle + ".json "
      + (result.fingerprint ? "fingerprint does not match current inputs" : "has no run fingerprint")
      + " — verified evidence treated as STALE");
  }
}

const requirementStates = {};
for (const [reqId, req] of requirementById) {
  const perOracle = {};
  for (const oracle of ORACLES) {
    const result = differential[oracle];
    if (!result) { perOracle[oracle] = { state: "UNTESTED" }; continue; }
    const stale = oracleFreshness[oracle] === "stale";
    const verdicts = (req.requiredProbes ?? []).map((probeId) => probeVerdictFor(result, probeId, { stale }));
    perOracle[oracle] = {
      state: reduceProbeVerdicts(verdicts, { declaredUnsupported: !!req.unsupported }),
      verdicts: Object.fromEntries((req.requiredProbes ?? []).map((probeId, i) => [probeId, verdicts[i]])),
    };
  }
  requirementStates[reqId] = { target: req.derivedTarget ?? req.target ?? null, oracles: perOracle };
}

// Discovery gaps: in-scope inventory items no requirement references.
const uncovered = [];
for (const [itemId, cls] of Object.entries(classification.items)) {
  if (cls.target === "in-scope" && spec.profiles[cls.profile]?.lifecycle === "active" && !referencedInventoryIds.has(itemId)) {
    uncovered.push(itemId);
  }
}
if (uncovered.length) {
  notes.push(uncovered.length + " in-scope upstream items have no requirement reference (coverage gap backlog) — see compat-results/capability-check.json");
}

const resolvedMatrix = {
  formatVersion: matrix.formatVersion,
  generatedAt: new Date().toISOString(),
  upstream: {
    pinned: driftPinned?.versions ?? {
      wrangler: manifest.wrangler,
      workersTypes: manifest.workersTypes,
      workerd: manifest.workerd,
    },
    latest: driftLatest?.versions ?? null,
  },
  verifiedAt: {
    pinned: differential.pinned?.checkedAt ?? null,
    latest: differential.latest?.checkedAt ?? null,
    hosted: differential.hosted?.checkedAt ?? null,
  },
  capabilities: resolved,
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "capabilities.json"), JSON.stringify(resolvedMatrix, null, 2) + "\n");
writeFileSync(join(resultsDir, "capability-check.json"), JSON.stringify({
  checkedAt: new Date().toISOString(),
  requirementStates,
  coverageGaps: { uncoveredUpstreamItems: uncovered.sort() },
  pass: errors.length === 0,
}, null, 2) + "\n");

if (notes.length) {
  for (const note of notes) console.error("note: " + note);
}
if (errors.length) {
  console.error("capability matrix violations:");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}
console.log("capability matrix OK: " + resolved.length + " capabilities, " + requirementById.size + " requirements, " + catalog.probes.length + " catalog probes");
