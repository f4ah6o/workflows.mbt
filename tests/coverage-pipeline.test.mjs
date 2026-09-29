// Hermetic tests for the coverage pipeline (issue 20260929 phases 4–6):
// run-result fingerprints, STALE detection, coverage.json derivation,
// the regression gate vs a base-branch baseline, inventory --report, and
// drift-record's inventory section. Everything runs against throwaway
// results dirs via WORKFLOWS_MBT_RESULTS_DIR; the committed baseline path
// is overridden via WORKFLOWS_MBT_COVERAGE_BASELINE.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildResultFingerprint,
  computeRelevantInputs,
  deriveRequirementTarget,
  reduceProbeVerdicts,
} from "../compat/coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dir() {
  return mkdtempSync(join(tmpdir(), "wfmbt-cov-"));
}

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120000,
  });
}

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
// A differential result must cover the whole differential-eligible catalog —
// anything less is a "stale or partial result" validator failure.
const allProbes = catalog.probes
  .filter((probe) => probe.differential !== false)
  .map((probe) => probe.id)
  .sort();

function freshFingerprint(oracle) {
  // candidate null ↔ no persisted candidate-<oracle>.json in the results dir,
  // which is what a hermetic results dir looks like.
  return buildResultFingerprint({
    runId: "test-run",
    oracle,
    candidate: null,
    relevantInputs: computeRelevantInputs(root, null),
    commit: "test-commit",
  });
}

function differentialResult(oracle, { fingerprint = freshFingerprint(oracle), differences = {}, probeErrors = {}, candidateId = "test-candidate" } = {}) {
  return {
    oracle,
    runId: "test-run",
    checkedAt: new Date().toISOString(),
    commit: "test-commit",
    candidateId,
    versions: {},
    probes: allProbes,
    cloudflare: {},
    workflowsMbt: {},
    differences,
    probeErrors,
    sideErrors: {},
    pass: Object.keys(differences).length === 0 && Object.keys(probeErrors).length === 0,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function writeResult(resultsDir, name, value) {
  writeFileSync(join(resultsDir, name), JSON.stringify(value, null, 2) + "\n");
}

const matrix = JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));
const requirements = matrix.requirements;
const classificationItems = JSON.parse(
  readFileSync(join(root, "compat/inventory/classification.json"), "utf8"),
).items;
const coreReqs = requirements.filter((req) => req.id.startsWith("req.workflows-core."));

// Expected per-requirement state under a differential run where every
// executed probe passes (or the given per-probe verdict override).
// Mirrors the model: UNSUPPORTED is declared, UNTESTED covers requirements
// with no executed probes (incl. catalog probes marked differential:false),
// otherwise the first-match reduction applies.
function expectedState(req, verdict = () => "VERIFIED") {
  if (req.unsupported) return "UNSUPPORTED";
  const probes = req.requiredProbes ?? [];
  if (!probes.length) return "UNTESTED";
  return reduceProbeVerdicts(
    probes.map((probeId) => (allProbes.includes(probeId) ? verdict(probeId) : "UNTESTED")),
  );
}
function expectedStates(profile, verdict) {
  const counts = { VERIFIED: 0, DIVERGENT: 0, UNSUPPORTED: 0, UNTESTED: 0, BLOCKED: 0, STALE: 0 };
  for (const req of requirements.filter((r) => r.id.startsWith("req." + profile + ".")
    && deriveRequirementTarget(r, classificationItems) === "in-scope")) {
    counts[expectedState(req, verdict)] += 1;
  }
  return counts;
}

// One probe covered by an in-scope requirement, for per-probe fixtures.
const someReq = requirements.find((req) => !req.unsupported
  && deriveRequirementTarget(req, classificationItems) === "in-scope"
  && (req.requiredProbes ?? []).length > 0
  && req.requiredProbes.every((probeId) => allProbes.includes(probeId)));
const someProbe = someReq.requiredProbes[0];

// A capabilities matrix where capabilities touching `probeId` no longer
// claim pinned_differential — required so injected probe errors/differences
// stay a valid fixture (declared flags on uncovered probes are a validator
// failure, not a coverage observation).
function matrixWithoutPinnedClaim(dirPath, probeId) {
  const modified = structuredClone(matrix);
  for (const cap of modified.capabilities) {
    if ((cap.probes ?? []).includes(probeId) && cap.declaredSupport?.pinned_differential) {
      cap.declaredSupport = { ...cap.declaredSupport, pinned_differential: false };
    }
  }
  const path = join(dirPath, "capabilities.json");
  writeFileSync(path, JSON.stringify(modified));
  return path;
}

function coverageEnv(dirPath) {
  return {
    WORKFLOWS_MBT_RESULTS_DIR: join(dirPath, "results"),
    WORKFLOWS_MBT_COVERAGE_BASELINE: join(dirPath, "baseline.json"),
  };
}

// ── coverage.mjs derivation ────────────────────────────────────────────────

test("coverage marks a fresh fully-passing run VERIFIED and UNSUPPORTED stays in the denominator", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });
  writeResult(join(dirPath, "results"), "differential-pinned.json", differentialResult("pinned"));

  const result = run("compat/coverage.mjs", [], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  assert.equal(coverage.status, "ok");

  const core = coverage.profiles["workflows-core"];
  const pinned = core.oracles.pinned;
  assert.equal(pinned.denominator, coreReqs.length, "denominator counts every in-scope workflows-core requirement");
  assert.deepEqual(pinned.states, expectedStates("workflows-core"));
  assert.deepEqual(coverage.profiles["workflow-host"].oracles.pinned.states, expectedStates("workflow-host"));
  // UNSUPPORTED sits in the denominator but never in the VERIFIED numerator.
  assert.ok(pinned.states.UNSUPPORTED >= 1);
  assert.equal(pinned.numerator, pinned.states.VERIFIED);
  assert.equal(coverage.oracles.pinned.fresh, true);
  // Latest/hosted were not run — measured:false, never silently verified.
  assert.equal(coverage.oracles.latest.measured, false);
  assert.equal(coverage.oracles.hosted.measured, false);
});

test("a result without a fingerprint is STALE evidence, never VERIFIED", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });
  writeResult(join(dirPath, "results"), "differential-pinned.json", differentialResult("pinned", { fingerprint: null }));

  const result = run("compat/coverage.mjs", [], env);
  assert.equal(result.status, 0, result.stderr);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  const pinned = coverage.profiles["workflows-core"].oracles.pinned;
  assert.equal(pinned.states.VERIFIED, 0);
  // STALE only downgrades executed evidence; requirements without probes
  // stay UNTESTED.
  assert.deepEqual(pinned.states, expectedStates("workflows-core", () => "STALE"));
  assert.equal(coverage.oracles.pinned.fresh, false);
});

test("a fingerprint mismatch is STALE; commit alone never stales evidence", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });

  const tampered = freshFingerprint("pinned");
  tampered.relevantInputs.catalogHash = "sha256:0";
  tampered.commit = "different-commit"; // commit is provenance only
  const staleResult = differentialResult("pinned", { fingerprint: tampered });
  // Also prove a same-inputs fingerprint with a different commit is fresh.
  const freshDiffCommit = { ...freshFingerprint("pinned"), commit: "other-commit" };

  writeResult(join(dirPath, "results"), "differential-pinned.json", staleResult);
  writeResult(join(dirPath, "results"), "differential-latest.json", differentialResult("latest", { fingerprint: freshDiffCommit }));

  const result = run("compat/coverage.mjs", [], env);
  assert.equal(result.status, 0, result.stderr);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  assert.equal(coverage.oracles.pinned.fresh, false);
  assert.equal(coverage.profiles["workflows-core"].oracles.pinned.states.VERIFIED, 0);
  assert.equal(coverage.oracles.latest.fresh, true, "commit change alone must not stale evidence");
});

test("probe errors become BLOCKED with upstream-observed-limitation reason", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });
  writeResult(join(dirPath, "results"), "differential-pinned.json", differentialResult("pinned", {
    probeErrors: { [someProbe]: { cloudflare: "worker exceeded isolate restart limit" } },
  }));
  env.WORKFLOWS_MBT_CAPABILITIES = matrixWithoutPinnedClaim(dirPath, someProbe);

  const result = run("compat/coverage.mjs", [], env);
  assert.equal(result.status, 0, result.stderr);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  assert.equal(coverage.oracles.pinned.probeVerdicts[someProbe], "BLOCKED");
  const affected = requirements.filter((req) => (req.requiredProbes ?? []).includes(someProbe) && !req.unsupported);
  assert.ok(affected.length > 0, "fixture probe must be covered by a requirement");
  for (const req of affected) {
    const state = coverage.oracles.pinned.requirements[req.id];
    assert.equal(state.state, "BLOCKED", req.id);
    assert.equal(state.blockedReasons[someProbe], "upstream-observed-limitation");
  }
});

test("trace differences become DIVERGENT and stay oracle-specific", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });
  writeResult(join(dirPath, "results"), "differential-pinned.json", differentialResult("pinned", {
    differences: { [someProbe]: { expected: {}, actual: {} } },
  }));
  writeResult(join(dirPath, "results"), "differential-latest.json", differentialResult("latest"));
  env.WORKFLOWS_MBT_CAPABILITIES = matrixWithoutPinnedClaim(dirPath, someProbe);

  const result = run("compat/coverage.mjs", [], env);
  assert.equal(result.status, 0, result.stderr);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  assert.equal(coverage.oracles.pinned.probeVerdicts[someProbe], "DIVERGENT");
  assert.equal(coverage.oracles.latest.probeVerdicts[someProbe], "VERIFIED",
    "pinned divergence must not bleed into the latest cell");
});

test("validator failure produces INVALID coverage and a non-zero exit", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  const badMatrix = join(dirPath, "bad-capabilities.json");
  const bad = structuredClone(matrix);
  bad.capabilities[0].requirements = ["req.workflows-core.nonexistent.requirement"];
  writeFileSync(badMatrix, JSON.stringify(bad));

  const result = run("compat/coverage.mjs", [], { ...env, WORKFLOWS_MBT_CAPABILITIES: badMatrix });
  assert.notEqual(result.status, 0);
  const coverage = JSON.parse(readFileSync(join(dirPath, "results", "coverage.json"), "utf8"));
  assert.equal(coverage.status, "INVALID");
});

test("report.mjs aborts when the validator fails — no normal report", () => {
  const dirPath = dir();
  const env = coverageEnv(dirPath);
  const badMatrix = join(dirPath, "bad-capabilities.json");
  const bad = structuredClone(matrix);
  bad.capabilities[0].requirements = ["req.workflows-core.nonexistent.requirement"];
  writeFileSync(badMatrix, JSON.stringify(bad));

  const result = run("compat/report.mjs", [], { ...env, WORKFLOWS_MBT_CAPABILITIES: badMatrix });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID|unvalidated/);
});

// ── regression gate (issue §13) ────────────────────────────────────────────

function seedPinnedRun(dirPath, resultOverride = {}) {
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned", resultOverride));
  return resultsDir;
}

function gateArgs(dirPath, basePath) {
  return ["--gate", "--base", basePath ?? join(dirPath, "missing-base.json")];
}

test("gate passes with no base baseline (first adoption)", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const result = run("compat/coverage.mjs", gateArgs(dirPath), coverageEnv(dirPath));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.equal(gate.status, "no-baseline");
});

test("gate passes when current coverage matches the baseline", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const env = coverageEnv(dirPath);
  // Generate the proposed baseline, then use a copy as the base baseline.
  const write = run("compat/coverage.mjs", ["--update-baseline"], env);
  assert.equal(write.status, 0, write.stderr);
  const base = join(dirPath, "base.json");
  writeFileSync(base, readFileSync(join(dirPath, "baseline.json")));
  const result = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8")).status, "pass");
});

test("gate fails on an uncovered VERIFIED numerator drop", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const env = coverageEnv(dirPath);
  run("compat/coverage.mjs", ["--update-baseline"], env);
  const baseline = JSON.parse(readFileSync(join(dirPath, "baseline.json"), "utf8"));
  // Fabricate a baseline that verified one more requirement than current.
  const core = baseline.profiles["workflows-core"];
  core.oracles.pinned.numerator += 1;
  core.oracles.pinned.verifiedRequirements.push("req.workflows-core.fake.dropped");
  const base = join(dirPath, "base.json");
  writeFileSync(base, JSON.stringify(baseline));

  const result = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.notEqual(result.status, 0);
  const gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.equal(gate.status, "fail");
  assert.ok(gate.problems.some((p) => p.includes("metric-drop") && p.includes("req.workflows-core.fake.dropped")));
});

test("gate fails on denominator shrink", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const env = coverageEnv(dirPath);
  run("compat/coverage.mjs", ["--update-baseline"], env);
  const baseline = JSON.parse(readFileSync(join(dirPath, "baseline.json"), "utf8"));
  baseline.profiles["workflows-core"].denominator += 1;
  baseline.profiles["workflows-core"].requirements.push("req.workflows-core.fake.removed");
  const base = join(dirPath, "base.json");
  writeFileSync(base, JSON.stringify(baseline));

  const result = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.notEqual(result.status, 0);
  const gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.ok(gate.problems.some((p) => p.includes("denominator-shrink")));
});

test("a correctly scoped waiver covers exactly its regression; unused waivers fail", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const env = coverageEnv(dirPath);
  run("compat/coverage.mjs", ["--update-baseline"], env);
  const current = JSON.parse(readFileSync(join(dirPath, "baseline.json"), "utf8"));
  const numerator = current.profiles["workflows-core"].oracles.pinned.numerator;

  // Base baseline claims one verified requirement the current run does not
  // deliver → an uncovered metric-drop regression until a waiver matches it.
  const base = structuredClone(current);
  base.profiles["workflows-core"].oracles.pinned.verifiedRequirements =
    [...base.profiles["workflows-core"].oracles.pinned.verifiedRequirements, "req.workflows-core.fake.dropped"].sort();
  const basePath = join(dirPath, "base.json");
  writeFileSync(basePath, JSON.stringify(base));

  const fail = run("compat/coverage.mjs", gateArgs(dirPath, basePath), env);
  assert.notEqual(fail.status, 0);

  // Matching waiver: kind/oracle/profile/metric/scope/before/after all exact.
  current.waivers = [{
    kind: "metric-drop",
    oracle: "pinned",
    profile: "workflows-core",
    metric: "verified-numerator",
    scope: ["req.workflows-core.fake.dropped"],
    before: numerator,
    after: numerator,
    reason: "intentional scope narrowing",
    issue: "issues/open/x.md",
  }];
  writeFileSync(join(dirPath, "baseline.json"), JSON.stringify(current));
  const pass = run("compat/coverage.mjs", gateArgs(dirPath, basePath), env);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);

  // An unused waiver is itself a gate failure (1:1 exhaustive matching).
  current.waivers.push({ kind: "metric-drop", oracle: "pinned", profile: "workflows-core", metric: "verified-numerator", scope: ["req.x"], before: numerator, after: numerator, reason: "stale", issue: "x" });
  writeFileSync(join(dirPath, "baseline.json"), JSON.stringify(current));
  const unused = run("compat/coverage.mjs", gateArgs(dirPath, basePath), env);
  assert.notEqual(unused.status, 0);
  const gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.ok(gate.problems.some((p) => p.includes("waiver did not match")));
});

test("an upstream pin change requires an upstream-pin-update waiver", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath, { candidateId: "cand-new" });
  const env = coverageEnv(dirPath);
  run("compat/coverage.mjs", ["--update-baseline"], env);
  const baseline = JSON.parse(readFileSync(join(dirPath, "baseline.json"), "utf8"));
  baseline.candidates.pinned = "cand-old";
  const base = join(dirPath, "base.json");
  writeFileSync(base, JSON.stringify(baseline));

  const fail = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.notEqual(fail.status, 0);
  let gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.ok(gate.problems.some((p) => p.includes("upstream-pin-update")));

  baseline.waivers = [{
    kind: "upstream-pin-update",
    oracle: "pinned",
    profile: "*",
    metric: "candidate",
    scope: ["*"],
    before: "cand-old",
    after: "cand-new",
    reason: "reviewed upstream bump",
    issue: "issues/open/x.md",
  }];
  // The proposed baseline keeps the CURRENT candidate — only the base is old.
  baseline.candidates.pinned = "cand-new";
  writeFileSync(join(dirPath, "baseline.json"), JSON.stringify(baseline));
  const pass = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);
  gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.equal(gate.waiversMatched, 1);
});

test("proposed baseline that disagrees with current coverage fails the gate", () => {
  const dirPath = dir();
  seedPinnedRun(dirPath);
  const env = coverageEnv(dirPath);
  run("compat/coverage.mjs", ["--update-baseline"], env);
  const baseline = JSON.parse(readFileSync(join(dirPath, "baseline.json"), "utf8"));
  baseline.profiles["workflows-core"].oracles.pinned.numerator -= 2;
  writeFileSync(join(dirPath, "baseline.json"), JSON.stringify(baseline));
  const base = join(dirPath, "base.json");
  writeFileSync(base, JSON.stringify(baseline));

  const result = run("compat/coverage.mjs", gateArgs(dirPath, base), env);
  assert.notEqual(result.status, 0);
  const gate = JSON.parse(readFileSync(join(dirPath, "results", "coverage-gate.json"), "utf8"));
  assert.ok(gate.problems.some((p) => p.includes("proposed baseline")));
});

// ── check-inventory --report + drift-record inventory integration ──────────

const FIXTURE_TYPES = `
declare module "cloudflare:workers" {
  export = CfwModule;
}
declare namespace CfwModule {
  export interface WorkflowStep {
    do(name: string, callback: () => Promise<StepOutput>): Promise<StepOutput>;
  }
}
interface StepOutput {
  value: string;
}
`;

const FIXTURE_SCHEMA = JSON.stringify({
  definitions: {
    RawConfig: {
      type: "object",
      properties: {
        workflows: { $ref: "#/definitions/WorkflowBinding" },
      },
    },
    WorkflowBinding: {
      type: "object",
      properties: { binding: { type: "string" } },
    },
  },
  allOf: [{ $ref: "#/definitions/RawConfig" }],
});

test("check-inventory --report writes classified inventory + diff without failing on drift", () => {
  const dirPath = dir();
  const resultsDir = join(dirPath, "results");
  const inv = join(dirPath, "inventory");
  mkdirSync(inv, { recursive: true });
  // Real baselines + classification; a spec whose roots are narrowed to the
  // fixture surface (every active profile must still match something).
  const spec = JSON.parse(readFileSync(join(root, "compat/inventory/discovery-roots.json"), "utf8"));
  spec.roots = {
    "workflows-core": { workersTypes: [{ container: "cloudflare:workers", names: ["WorkflowStep"] }] },
    "workflow-host": { workersTypes: [{ container: "global", names: ["StepOutput"] }] },
    "binding-adapters": { wranglerSchema: ["workflows"] },
    "workers-platform": spec.roots["workers-platform"],
  };
  writeFileSync(join(inv, "discovery-roots.json"), JSON.stringify(spec));
  for (const name of ["upstream-api.json", "upstream-config.json", "semantic.json", "classification.json"]) {
    writeFileSync(join(inv, name), readFileSync(join(root, "compat/inventory", name)));
  }
  writeFileSync(join(dirPath, "types.d.ts"), FIXTURE_TYPES);
  writeFileSync(join(dirPath, "schema.json"), FIXTURE_SCHEMA);
  const result = run("compat/check-inventory.mjs", [
    "--report", "--mode", "pinned",
    "--types", join(dirPath, "types.d.ts"),
    "--schema", join(dirPath, "schema.json"),
  ], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir, WORKFLOWS_MBT_INVENTORY_DIR: inv });
  assert.equal(result.status, 0, result.stderr);

  const inventory = JSON.parse(readFileSync(join(resultsDir, "inventory-pinned.json"), "utf8"));
  assert.equal(inventory.status, "ok");
  assert.ok(inventory.items.every((item) => item.kind === "api" || item.kind === "config"));
  assert.ok(inventory.items.some((item) => item.id === "cloudflare:workers.WorkflowStep.do"));
  assert.ok(Array.isArray(inventory.unclassified));

  const diff = JSON.parse(readFileSync(join(resultsDir, "inventory-diff-pinned.json"), "utf8"));
  assert.equal(diff.status, "ok");
  // Fixture upstream is a tiny subset of the committed baseline — removal
  // drift is recorded, never fatal.
  assert.ok(diff.api.removed.length > 0);
});

test("drift-record surfaces inventory drift in the packet and problem identity", () => {
  const dirPath = dir();
  const resultsDir = join(dirPath, "results");
  const issuesDir = join(dirPath, "issues");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "inventory-diff-latest.json", {
    status: "ok",
    api: { label: "upstream-api", added: ["cloudflare:workers.NewSurface"], changed: [], removed: [] },
    config: { label: "upstream-config", added: [], changed: [], removed: [] },
  });

  const result = run("compat/drift-record.mjs", ["--oracle", "latest"], {
    WORKFLOWS_MBT_RESULTS_DIR: resultsDir,
    WORKFLOWS_MBT_ISSUES_DIR: issuesDir,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote .*drift-/);

  const packet = readdirSync(resultsDir).find((f) => f.startsWith("drift-") && f.endsWith(".md"));
  const body = readFileSync(join(resultsDir, packet), "utf8");
  assert.match(body, /Upstream inventory drift/);
  assert.match(body, /cloudflare:workers\.NewSurface/);
  assert.match(body, /classification\.json/);
});

test("check-capabilities downgrades unfingerprinted runs to STALE with a note", () => {
  const dirPath = dir();
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned", { fingerprint: null }));
  const result = run("compat/check-capabilities.mjs", [], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /fingerprint/);
  const check = JSON.parse(readFileSync(join(resultsDir, "capability-check.json"), "utf8"));
  const states = new Set(Object.values(check.requirementStates).map((s) => s.oracles.pinned.state));
  assert.ok(states.has("STALE"));
  assert.ok(!states.has("VERIFIED"), "no VERIFIED without a fingerprint");
});
