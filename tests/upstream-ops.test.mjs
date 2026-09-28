// Upstream-tracking fault-injection suite (spec §7). Every case is hermetic:
// it runs the real compat/*.mjs scripts against a throwaway results dir via
// WORKFLOWS_MBT_RESULTS_DIR, so failures are injected by crafting evidence —
// never by waiting for real upstream breakage. Nothing here counts a skipped,
// unexecuted, or failed check as a pass.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const differentialProbes = catalog.probes
  .filter((probe) => probe.differential !== false)
  .map((probe) => probe.id);

function dir() {
  return mkdtempSync(join(tmpdir(), "wfmbt-ops-"));
}

function write(dirPath, name, value) {
  writeFileSync(join(dirPath, name), typeof value === "string" ? value : JSON.stringify(value));
}

function read(dirPath, name) {
  return JSON.parse(readFileSync(join(dirPath, name), "utf8"));
}

function run(script, args, resultsDir, env = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    env: {
      ...process.env,
      WORKFLOWS_MBT_RESULTS_DIR: resultsDir,
      WORKFLOWS_MBT_ISSUES_DIR: join(resultsDir, "issues-open"),
      ...env,
    },
    encoding: "utf8",
    timeout: 120000,
  });
}

function verdictFor(dirPath) {
  const result = run("compat/verdict.mjs", ["--oracle", "latest", "--results-dir", dirPath], dirPath);
  return { result, verdict: read(dirPath, "verdict-latest.json") };
}

// A complete passing evidence set — the happy path every case mutates.
function seedPassing(dirPath, { runId = "run-1", candidateId = "cand-1", overrides = {} } = {}) {
  write(dirPath, "candidate-latest.json", {
    status: "ok",
    id: candidateId,
    mode: "latest",
    resolvedAt: "2026-09-28T00:00:00Z",
    source: "npm-registry",
    versions: { wrangler: "4.142.0", workersTypes: "5.20260928.1", workerd: "1.20260928.1" },
    integrity: { wrangler: "sha512-x", workersTypes: "sha512-y", workerd: "sha512-z" },
    runtime: { wrangler: "4.142.0", miniflare: "5.0", workerd: "1.20260928.1" },
    dependencyCount: 36,
    conditions: { compatibilityDate: "2026-09-26", compatibilityFlags: [] },
    ...overrides.candidate,
  });
  write(dirPath, "drift-latest.json", {
    mode: "latest", runId, candidateId, checkedAt: "2026-09-28T00:00:01Z", pass: true,
    drift: { added: [], removed: [], changed: [] }, ...overrides.contract,
  });
  write(dirPath, "differential-latest.json", {
    oracle: "latest", runId, candidateId, checkedAt: "2026-09-28T00:00:02Z",
    probes: differentialProbes, differences: {}, probeErrors: {}, sideErrors: {},
    pass: true, ...overrides.differential,
  });
  write(dirPath, "typecheck-latest.json", {
    runId, candidateId, pass: true, diagnostics: [], ...overrides.typecheck,
  });
}

test("one shared candidate binds every phase of a run", () => {
  const d = dir();
  seedPassing(d);
  const { verdict } = verdictFor(d);
  assert.equal(verdict.verdict, "compatible");
  assert.equal(verdict.pass, true);
  assert.equal(verdict.candidate.runtime.workerd, "1.20260928.1",
    "verdict must carry the real transitive runtime graph, not just top-level versions");
  rmSync(d, { recursive: true, force: true });
});

test("phases that ran under different candidates or runs are rejected", () => {
  const d = dir();
  seedPassing(d);
  // A phase that verified a different upstream tuple (split-resolution bug).
  write(d, "differential-latest.json", {
    oracle: "latest", runId: "run-1", candidateId: "cand-OTHER",
    checkedAt: "2026-09-28T00:00:02Z", probes: differentialProbes,
    differences: {}, probeErrors: {}, sideErrors: {}, pass: true,
  });
  const { verdict: v1 } = verdictFor(d);
  assert.equal(v1.verdict, "incomplete-evidence");

  const d2 = dir();
  seedPassing(d2, { overrides: { differential: { runId: "run-OTHER" } } });
  const { verdict: v2 } = verdictFor(d2);
  assert.equal(v2.verdict, "incomplete-evidence");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});

test("contract drift and semantic drift classify distinctly", () => {
  const d = dir();
  seedPassing(d, { overrides: { contract: { pass: false, drift: { added: ["Workflow.foo"], removed: [], changed: [] } } } });
  assert.equal(verdictFor(d).verdict.verdict, "contract-drift");

  const d2 = dir();
  seedPassing(d2, { overrides: { differential: { pass: false, differences: { basic: { expected: [], actual: [] } } } } });
  const v2 = verdictFor(d2).verdict;
  assert.equal(v2.verdict, "semantic-drift");

  const d3 = dir();
  seedPassing(d3, { overrides: { typecheck: { pass: false, diagnostics: ["error TS2339"] } } });
  assert.equal(verdictFor(d3).verdict.verdict, "contract-drift");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  rmSync(d3, { recursive: true, force: true });
});

test("upstream acquisition/execution failure is never compatible", () => {
  const d = dir();
  write(d, "candidate-latest.json", {
    status: "acquisition-failure", phase: "resolve",
    error: "npm view wrangler@latest failed: registry ECONNREFUSED",
    id: "latest-failed",
  });
  assert.equal(verdictFor(d).verdict.verdict, "upstream-acquisition-failure");

  const d2 = dir();
  seedPassing(d2, { overrides: { differential: { pass: false, sideErrors: { cloudflare: "workerd exited 1" } } } });
  assert.equal(verdictFor(d2).verdict.verdict, "upstream-execution-failure");

  const d3 = dir();
  seedPassing(d3, { overrides: { differential: { pass: false, sideErrors: { workflowsMbt: "dev server crashed" } } } });
  assert.equal(verdictFor(d3).verdict.verdict, "local-runtime-failure");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  rmSync(d3, { recursive: true, force: true });
});

test("missing, malformed, and partial evidence is rejected", () => {
  // nothing at all
  const d = dir();
  assert.equal(verdictFor(d).verdict.verdict, "incomplete-evidence");

  // malformed JSON result file
  const d2 = dir();
  seedPassing(d2);
  write(d2, "differential-latest.json", "{not json");
  assert.equal(verdictFor(d2).verdict.verdict, "incomplete-evidence");

  // required field absent
  const d3 = dir();
  seedPassing(d3);
  const diff = read(d3, "differential-latest.json");
  delete diff.candidateId;
  write(d3, "differential-latest.json", diff);
  assert.equal(verdictFor(d3).verdict.verdict, "incomplete-evidence");

  // zero/partial probe coverage is never compatible
  const d4 = dir();
  seedPassing(d4, { overrides: { differential: { probes: [differentialProbes[0]] } } });
  const v4 = verdictFor(d4).verdict;
  assert.equal(v4.verdict, "incomplete-evidence");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  rmSync(d3, { recursive: true, force: true });
  rmSync(d4, { recursive: true, force: true });
});

test("hosted oracle with no evidence reports hosted-not-performed", () => {
  const d = dir();
  const result = run("compat/verdict.mjs", ["--oracle", "hosted", "--results-dir", d], d);
  assert.notEqual(result.status, 0);
  assert.equal(read(d, "verdict-hosted.json").verdict, "hosted-not-performed");
  rmSync(d, { recursive: true, force: true });
});

test("drift records dedup by problem identity, not version", () => {
  const d = dir();
  const driftEvidence = (runId, tuple) => {
    seedPassing(d, { runId, overrides: {
      differential: {
        pass: false,
        differences: { basic: { expected: ["a"], actual: ["b"] } },
      },
      candidate: { versions: { wrangler: tuple, workersTypes: "1", workerd: "1" } },
    } });
    write(d, "verdict-latest.json", {
      oracle: "latest", verdict: "semantic-drift", pass: false, runId,
    });
  };
  driftEvidence("run-a", "4.142.0");
  const r1 = run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  assert.equal(r1.status, 0, r1.stderr);
  const state1 = read(d, "drift-state.json");
  const keys1 = Object.keys(state1.keys);
  assert.equal(keys1.length, 1, "first drift creates exactly one record");

  // Same root cause under a NEW upstream tuple: same problem key, no new record.
  driftEvidence("run-b", "4.143.0");
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  const state2 = read(d, "drift-state.json");
  assert.deepEqual(Object.keys(state2.keys), keys1, "same problem must not create a second record");
  assert.deepEqual(
    state2.keys[keys1[0]].versionsSeen,
    ["4.142.0/1/1", "4.143.0/1/1"],
    "the new observed tuple is tracked on the existing record",
  );
  assert.equal(state2.keys[keys1[0]].observations, 2);
  // The same packet is also upserted into issues/open (repo convention) —
  // one dated file per problem identity, never per version.
  const issueFiles = readdirSync(join(d, "issues-open"));
  assert.equal(issueFiles.length, 1);
  assert.match(issueFiles[0], /^\d{8}-drift-[0-9a-f]{8}\.md$/);
  const issueBody = readFileSync(join(d, "issues-open", issueFiles[0]), "utf8");
  assert.match(issueBody, /Versions seen: 4\.142\.0\/1\/1, 4\.143\.0\/1\/1/);

  // Compatible evidence resolves the record; drift on the same probes recurs it.
  seedPassing(d, { runId: "run-c" });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-c" });
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  const state3 = read(d, "drift-state.json");
  assert.equal(state3.keys[keys1[0]].status, "resolved");

  driftEvidence("run-d", "4.143.0");
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  const state4 = read(d, "drift-state.json");
  assert.equal(state4.keys[keys1[0]].status, "recurred");
  assert.equal(state4.keys[keys1[0]].recurCount, 1);
  rmSync(d, { recursive: true, force: true });
});

test("publish never claims success without a working destination", () => {
  const d = dir();
  seedPassing(d, { overrides: {
    differential: { pass: false, differences: { basic: {} } },
  } });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false });
  // No GITHUB_REPOSITORY, no token: the publisher must record the skipped
  // outcome in publish-*.json instead of pretending it notified.
  const env = { GITHUB_REPOSITORY: "", GH_TOKEN: "", GITHUB_TOKEN: "" };
  const result = run("compat/drift-record.mjs", ["--oracle", "latest", "--publish"], d, env);
  assert.equal(result.status, 0, result.stderr);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];
  const outcome = read(d, `publish-${key}.json`);
  assert.equal(outcome.destinations.file.status, "written");
  assert.notEqual(outcome.destinations.github.status, "created");
  assert.notEqual(outcome.destinations.github.status, "commented");

  // Mock-dir publisher is testable: emits the exact issue payload.
  const d2 = dir();
  seedPassing(d2, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
  write(d2, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false });
  const mockDir = join(d2, "mock");
  const r2 = run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mockDir], d2);
  assert.equal(r2.status, 0, r2.stderr);
  const key2 = Object.keys(read(d2, "drift-state.json").keys)[0];
  const payload = read(mockDir, `${key2}.issue.json`);
  assert.equal(payload.action, "create");
  assert.match(payload.body, /Minimal fix candidates/);
  assert.match(payload.body, /Reproduce/);
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});

test("update candidates never promote a baseline without a compatible verdict", () => {
  // compatible -> proposed file, and manifest.json is untouched.
  const manifestBefore = readFileSync(join(root, "compat/oracle/manifest.json"), "utf8");
  const d = dir();
  seedPassing(d);
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-1" });
  run("compat/update-candidate.mjs", ["--oracle", "latest"], d);
  const proposal = read(d, "update-candidate-latest.json");
  assert.equal(proposal.status, "proposed");
  assert.ok(existsSync(join(d, "proposed-manifest.json")));
  assert.equal(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"), manifestBefore,
    "the baseline manifest must never be modified by candidate generation");

  // drift -> blocked, no proposal file.
  const d2 = dir();
  seedPassing(d2);
  write(d2, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false });
  run("compat/update-candidate.mjs", ["--oracle", "latest"], d2);
  const blocked = read(d2, "update-candidate-latest.json");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.requiresImplementationChange, true);
  assert.ok(!existsSync(join(d2, "proposed-manifest.json")));

  // upstream failure -> no-update.
  const d3 = dir();
  write(d3, "verdict-latest.json", { oracle: "latest", verdict: "upstream-acquisition-failure", pass: false });
  run("compat/update-candidate.mjs", ["--oracle", "latest"], d3);
  assert.equal(read(d3, "update-candidate-latest.json").status, "no-update");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  rmSync(d3, { recursive: true, force: true });
});

test("pinned candidate records the real transitive runtime graph offline", () => {
  const d = dir();
  const result = run("compat/candidate.mjs", ["--mode", "pinned"], d);
  assert.equal(result.status, 0, result.stderr);
  const candidate = read(d, "candidate-pinned.json");
  assert.equal(candidate.status, "ok");
  assert.ok(candidate.runtime.miniflare, "runtime must record the actually-resolved miniflare");
  assert.ok(candidate.runtime.workerd, "runtime must record the actually-resolved workerd");
  assert.ok(candidate.dependencyCount > 0);
  for (const name of ["wrangler", "workersTypes", "workerd"]) {
    assert.ok(candidate.versions[name], `missing version for ${name}`);
    assert.ok(candidate.integrity[name], `missing integrity hash for ${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));
  assert.equal(candidate.versions.wrangler, manifest.wrangler,
    "pinned resolution must come from the repo lockfile, not a fresh registry lookup");
  rmSync(d, { recursive: true, force: true });
});

test("registry failure produces an acquisition-failure record, not silence", () => {
  const d = dir();
  const result = run(
    "compat/candidate.mjs", ["--mode", "latest", "--refresh"], d,
    // Unreachable registry: npm view fails fast with ECONNREFUSED (retries
    // and the default fetch timeout are disabled so the injection is quick).
    {
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
      npm_config_fetch_retry_mintimeout: "100",
      npm_config_fetch_retry_maxtimeout: "500",
      npm_config_fetch_timeout: "5000",
    },
  );
  assert.equal(result.status, 1);
  const candidate = read(d, "candidate-latest.json");
  assert.equal(candidate.status, "acquisition-failure");
  assert.ok(candidate.error, "acquisition failure must record the error");
  rmSync(d, { recursive: true, force: true });
});
