// Hermetic tests for compat/upstream-coverage.mjs — the upstream-item-level
// coverage view (denominator = in-scope inventory items, linkage = the
// committed requirement/capability refs, states derived per oracle).
// Everything runs against throwaway results dirs via WORKFLOWS_MBT_* env
// overrides, same pattern as coverage-pipeline.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildResultFingerprint,
  computeRelevantInputs,
  reduceProbeVerdicts,
} from "../compat/coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dir() {
  return mkdtempSync(join(tmpdir(), "wfmbt-upcov-"));
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [join(root, "compat/upstream-coverage.mjs"), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120000,
  });
}

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const allProbes = catalog.probes
  .filter((probe) => probe.differential !== false)
  .map((probe) => probe.id)
  .sort();

const matrix = JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));
const classificationItems = JSON.parse(
  readFileSync(join(root, "compat/inventory/classification.json"), "utf8"),
).items;
const spec = JSON.parse(readFileSync(join(root, "compat/inventory/discovery-roots.json"), "utf8"));

// In-scope denominator: classification target in-scope under an active
// profile — the same rule check-capabilities.mjs uses for coverageGaps.
const inScopeIds = Object.entries(classificationItems)
  .filter(([, cls]) => cls.target === "in-scope" && spec.profiles[cls.profile]?.lifecycle === "active")
  .map(([id]) => id)
  .sort();
const itemRequirements = new Map();
for (const req of matrix.requirements) {
  for (const ref of req.upstreamRefs ?? []) {
    if (!itemRequirements.has(ref)) itemRequirements.set(ref, []);
    itemRequirements.get(ref).push(req.id);
  }
}
const mappedIds = inScopeIds.filter((id) => (itemRequirements.get(id) ?? []).length > 0);
const unmappedIds = inScopeIds.filter((id) => (itemRequirements.get(id) ?? []).length === 0);

// Expected item state under a run where every executed probe gets the given
// verdict. Mirrors the script: UNSUPPORTED requirements are declared intent —
// an item is UNSUPPORTED only when every referencing requirement is.
function expectedItemState(itemId, verdict = () => "VERIFIED") {
  const reqs = itemRequirements.get(itemId) ?? [];
  if (reqs.length === 0) return "UNMAPPED";
  const reqById = new Map(matrix.requirements.map((req) => [req.id, req]));
  const states = reqs.map((reqId) => {
    const req = reqById.get(reqId);
    if (req.unsupported) return "UNSUPPORTED";
    const probes = req.requiredProbes ?? [];
    if (!probes.length) return "UNTESTED";
    return reduceProbeVerdicts(
      probes.map((probeId) => (allProbes.includes(probeId) ? verdict(probeId) : "UNTESTED")),
    );
  });
  const testable = states.filter((state) => state !== "UNSUPPORTED");
  if (testable.length === 0) return "UNSUPPORTED";
  for (const state of ["DIVERGENT", "BLOCKED", "STALE", "UNTESTED"]) {
    if (testable.includes(state)) return state;
  }
  return testable.every((state) => state === "VERIFIED") ? "VERIFIED" : "UNTESTED";
}
function expectedStates(verdict) {
  const counts = { VERIFIED: 0, DIVERGENT: 0, UNSUPPORTED: 0, UNTESTED: 0, BLOCKED: 0, STALE: 0, UNMAPPED: 0 };
  for (const id of inScopeIds) counts[expectedItemState(id, verdict)] += 1;
  return counts;
}

function freshFingerprint(oracle) {
  return buildResultFingerprint({
    runId: "test-run",
    oracle,
    candidate: null,
    relevantInputs: computeRelevantInputs(root, null),
    commit: "test-commit",
  });
}

function differentialResult(oracle, { fingerprint = freshFingerprint(oracle), differences = {}, probeErrors = {} } = {}) {
  return {
    oracle,
    runId: "test-run",
    checkedAt: new Date().toISOString(),
    commit: "test-commit",
    candidateId: "test-candidate",
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

function envFor(dirPath) {
  return { WORKFLOWS_MBT_RESULTS_DIR: join(dirPath, "results") };
}

test("no compat results: mapped items UNTESTED, unmapped items UNMAPPED", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });

  const result = run([], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const report = JSON.parse(readFileSync(join(dirPath, "results", "upstream-coverage.json"), "utf8"));
  assert.equal(report.status, "ok");
  assert.equal(report.scope.inScope, inScopeIds.length);
  assert.equal(report.overall.items, inScopeIds.length);
  assert.equal(report.overall.mapped, mappedIds.length);
  for (const oracle of ["pinned", "latest", "hosted"]) {
    assert.equal(report.overall.oracles[oracle].measured, false);
    assert.equal(report.overall.oracles[oracle].states.UNMAPPED, unmappedIds.length);
    assert.equal(report.overall.oracles[oracle].states.UNTESTED, mappedIds.length);
    assert.equal(report.overall.oracles[oracle].verified, 0);
  }
  // The unmapped set is exactly the validator's coverage-gap backlog.
  const check = JSON.parse(readFileSync(join(dirPath, "results", "capability-check.json"), "utf8"));
  assert.deepEqual(
    report.items.filter((item) => item.requirements.length === 0).map((item) => item.id),
    check.coverageGaps.uncoveredUpstreamItems,
  );
  // Item ordering is stable (sorted by id).
  assert.deepEqual(report.items.map((item) => item.id), [...inScopeIds].sort());
  assert.ok(existsSync(join(dirPath, "results", "upstream-coverage.md")));
});

test("a fresh fully-passing pinned run verifies mapped items per-oracle only", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned"));

  const result = run([], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(join(resultsDir, "upstream-coverage.json"), "utf8"));

  assert.deepEqual(report.overall.oracles.pinned.states, expectedStates());
  assert.ok(report.overall.oracles.pinned.verified > 0);
  assert.equal(report.overall.oracles.pinned.verified, report.overall.oracles.pinned.states.VERIFIED);
  // Latest/hosted unmeasured: mapped items stay UNTESTED, never merge.
  assert.equal(report.overall.oracles.latest.states.VERIFIED, 0);
  assert.equal(report.overall.oracles.hosted.measured, false);
});

test("unfingerprinted run evidence is STALE for mapped items", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned", { fingerprint: null }));

  const result = run([], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(join(resultsDir, "upstream-coverage.json"), "utf8"));
  assert.equal(report.overall.oracles.pinned.measured, true);
  assert.equal(report.overall.oracles.pinned.fresh, false);
  assert.deepEqual(report.overall.oracles.pinned.states, expectedStates(() => "STALE"));
});

test("--oracle restricts the report to one oracle", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned"));
  writeResult(resultsDir, "differential-latest.json", differentialResult("latest"));

  const result = run(["--oracle", "pinned"], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(readFileSync(join(resultsDir, "upstream-coverage.json"), "utf8"));
  assert.deepEqual(Object.keys(report.overall.oracles), ["pinned"]);
  assert.ok(report.items.every((item) => Object.keys(item.states).length === 1));
  const md = readFileSync(join(resultsDir, "upstream-coverage.md"), "utf8");
  assert.match(md, /verified@pinned/);
  assert.doesNotMatch(md, /verified@latest/);
});

test("--json-only writes only the JSON report", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });

  const result = run(["--json-only"], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(join(dirPath, "results", "upstream-coverage.json")));
  assert.ok(!existsSync(join(dirPath, "results", "upstream-coverage.md")));
});

test("--min-mapped and --min-verified gate the exit code", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  const resultsDir = join(dirPath, "results");
  mkdirSync(resultsDir, { recursive: true });

  // mapped% is ~9 — a 50% floor fails, the actual floor passes.
  const fail = run(["--min-mapped", "50"], env);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /min-mapped/);
  const pass = run(["--min-mapped", "5"], env);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);

  // min-verified with no measured oracle fails explicitly.
  const unmeasured = run(["--min-verified", "1"], env);
  assert.equal(unmeasured.status, 1);
  assert.match(unmeasured.stderr, /no measured run/);

  // With a fresh pinned run, verified% is real and thresholdable.
  writeResult(resultsDir, "differential-pinned.json", differentialResult("pinned"));
  const rerun = run([], env);
  assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
  const report = JSON.parse(readFileSync(join(resultsDir, "upstream-coverage.json"), "utf8"));
  const verifiedPct = report.overall.oracles.pinned.verifiedPct;
  assert.ok(verifiedPct > 0);
  const under = run(["--oracle", "pinned", "--min-verified", String(Math.max(0, verifiedPct - 1))], env);
  assert.equal(under.status, 0, under.stderr + under.stdout);
  const over = run(["--oracle", "pinned", "--min-verified", String(Math.min(100, verifiedPct + 5))], env);
  assert.equal(over.status, 1);
  const gated = JSON.parse(readFileSync(join(resultsDir, "upstream-coverage.json"), "utf8"));
  assert.equal(gated.status, "below-threshold");
});

test("invalid flag values and validator failures exit non-zero", () => {
  const dirPath = dir();
  const env = envFor(dirPath);
  mkdirSync(join(dirPath, "results"), { recursive: true });

  assert.equal(run(["--oracle", "bogus"], env).status, 2);
  assert.equal(run(["--min-mapped", "abc"], env).status, 2);
  assert.equal(run(["--min-verified", "101"], env).status, 2);

  const badMatrix = join(dirPath, "bad-capabilities.json");
  const bad = structuredClone(matrix);
  bad.capabilities[0].requirements = ["req.workflows-core.nonexistent.requirement"];
  writeFileSync(badMatrix, JSON.stringify(bad));

  const result = run([], { ...env, WORKFLOWS_MBT_CAPABILITIES: badMatrix });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(readFileSync(join(dirPath, "results", "upstream-coverage.json"), "utf8"));
  assert.equal(report.status, "INVALID");
  // No human report on unvalidated data.
  assert.ok(!existsSync(join(dirPath, "results", "upstream-coverage.md")));
});
