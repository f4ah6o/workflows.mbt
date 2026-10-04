import { differentialProbes as probesForCandidate } from "../compat/candidate-policy.mjs";
// Upstream-tracking fault-injection suite (spec §7). Every case is hermetic:
// it runs the real compat/*.mjs scripts against a throwaway results dir via
// WORKFLOWS_MBT_RESULTS_DIR, so failures are injected by crafting evidence —
// never by waiting for real upstream breakage. Nothing here counts a skipped,
// unexecuted, or failed check as a pass.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const differentialProbes = probesForCandidate(catalog, { versions: { workersTypes: "5.20260928.1" } });

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

  // A phase-reported acquisition failure is upstream-side even when the
  // candidate record itself is absent from this evidence set's meaning.
  const d4 = dir();
  seedPassing(d4, { overrides: { typecheck: { pass: false, phaseStatus: "upstream-acquisition-failure", error: "candidate unusable" } } });
  assert.equal(verdictFor(d4).verdict.verdict, "upstream-acquisition-failure");
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  rmSync(d3, { recursive: true, force: true });
  rmSync(d4, { recursive: true, force: true });
});

test("a local toolchain failure is never reported as drift", () => {
  // run-typecheck records phaseStatus:"toolchain-failure" when tsc cannot
  // even spawn — that is a local failure, not contract drift.
  const d = dir();
  seedPassing(d, { overrides: { typecheck: { pass: false, phaseStatus: "toolchain-failure", error: "spawn tsc ENOENT" } } });
  assert.equal(verdictFor(d).verdict.verdict, "local-runtime-failure");
  rmSync(d, { recursive: true, force: true });
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

  // Second recovery: a recurred record resolves again on positive evidence.
  seedPassing(d, { runId: "run-e" });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-e" });
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  assert.equal(read(d, "drift-state.json").keys[keys1[0]].status, "resolved",
    "a recurred record must resolve again on compatible evidence");
  assert.match(readFileSync(join(d, "issues-open", issueFiles[0]), "utf8"), /^Status: resolved/m,
    "the durable issue file reflects resolution");

  // Cross-run durability: a fresh checkout has no drift-state.json — the
  // committed issue packet's state footer rebuilds it. Rename to an older
  // date first to prove a later re-observation never creates a second file.
  const oldName = "20260101-" + issueFiles[0].replace(/^\d{8}-/, "");
  renameSync(join(d, "issues-open", issueFiles[0]), join(d, "issues-open", oldName));
  rmSync(join(d, "drift-state.json"));
  driftEvidence("run-f", "4.143.0");
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  assert.deepEqual(readdirSync(join(d, "issues-open")), [oldName],
    "re-observing the same problem updates the original packet in place");
  const state6 = read(d, "drift-state.json");
  assert.equal(state6.keys[keys1[0]].status, "recurred",
    "state rebuilt from the issue footer keeps resolve/recur semantics");
  assert.equal(state6.keys[keys1[0]].recurCount, 2);
  assert.deepEqual(state6.keys[keys1[0]].versionsSeen, ["4.142.0/1/1", "4.143.0/1/1"],
    "versionsSeen survives the sidecar reset");
  rmSync(d, { recursive: true, force: true });
});

test("resolutions reach the publish path in the two-invocation shape", () => {
  const d = dir();
  const mock = join(d, "mock");
  // 1) drift observed, recorded, and published — the issue exists to close.
  seedPassing(d, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false, runId: "run-a" });
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];

  // 2) compatible run resolves it — the record invocation exits without
  // publishing, but the transition must survive to the --publish call.
  seedPassing(d, { runId: "run-b" });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-b" });
  run("compat/drift-record.mjs", ["--oracle", "latest"], d);
  assert.equal(read(d, "drift-state.json").keys[key].status, "resolved");

  // 3) the workflow's --publish invocation still delivers the transition:
  // comment + close payload via the mock destination.
  const r = run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(readFileSync(join(mock, key + ".resolution.json"), "utf8"));
  assert.equal(payload.action, "resolve");
  assert.equal(payload.close, true);
  assert.match(payload.body, /Resolved under 4\.142\.0\/5\.20260928\.1\/1\.20260928\.1/);
  assert.equal(read(d, "drift-state.json").keys[key].resolutionPublishedAt != null, true,
    "a delivered resolution is marked so repeats post nothing");
  rmSync(d, { recursive: true, force: true });
});

test("an identical re-observation after create posts nothing", () => {
  const d = dir();
  const mock = join(d, "mock");
  seedPassing(d, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false, runId: "run-a" });
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];
  let payload = JSON.parse(readFileSync(join(mock, key + ".issue.json"), "utf8"));
  assert.equal(payload.action, "create");

  // Same drift, second publish: zero comments on the issue, so dedup must
  // fall back to the issue body — otherwise it re-comments once.
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  payload = JSON.parse(readFileSync(join(mock, key + ".issue.json"), "utf8"));
  assert.equal(payload.action, "skipped", "identical observation must not re-comment");
  const store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  const issue = Object.values(store.issues)[0];
  assert.equal(issue.comments.length, 0, "no comment was posted");
  rmSync(d, { recursive: true, force: true });
});

test("resolve -> recur -> resolve drives reopen and republish", () => {
  const d = dir();
  const mock = join(d, "mock");
  const seedDrift = () => {
    seedPassing(d, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
    write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false, runId: "run-d" });
  };
  const seedCompatible = () => {
    seedPassing(d, { runId: "run-c" });
    write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-c" });
  };
  seedDrift();
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];

  seedCompatible();
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  assert.equal(read(d, "drift-state.json").keys[key].resolutionPublishedAt != null, true);
  let store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  assert.equal(Object.values(store.issues)[0].state, "CLOSED");

  // The drift recurs: the resolution marker must clear so the next
  // recovery republishes, and the closed issue must reopen.
  seedDrift();
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const entry = read(d, "drift-state.json").keys[key];
  assert.equal(entry.status, "recurred");
  assert.equal(entry.resolutionPublishedAt == null, true, "recurrence clears the delivered marker");
  store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  assert.equal(Object.values(store.issues)[0].state, "OPEN");

  seedCompatible();
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  assert.equal(read(d, "drift-state.json").keys[key].resolutionPublishedAt != null, true,
    "the second resolution is published, not swallowed by the first marker");
  store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  assert.equal(Object.values(store.issues)[0].state, "CLOSED");
  rmSync(d, { recursive: true, force: true });
});

test("a failed close retries instead of marking the resolution delivered", () => {
  const d = dir();
  const mock = join(d, "mock");
  seedPassing(d, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false, runId: "run-a" });
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];

  seedPassing(d, { runId: "run-b" });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-b" });
  writeFileSync(join(mock, "fail-close"), "");
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  let entry = read(d, "drift-state.json").keys[key];
  assert.equal(entry.status, "resolved");
  assert.equal(entry.resolutionPublishedAt == null, true, "partial failure stays pending");
  let store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  assert.equal(Object.values(store.issues)[0].state, "OPEN");
  assert.equal(Object.values(store.issues)[0].comments.length, 1, "comment posted before close failed");

  // Retry under a DIFFERENT run id (the next scheduled run): the frozen
  // resolutionBody — not a freshly generated one — is deduplicated against
  // the posted comment, close succeeds, and the marker is stamped.
  rmSync(join(mock, "fail-close"));
  seedPassing(d, { runId: "run-b-later" });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-b-later" });
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  entry = read(d, "drift-state.json").keys[key];
  assert.equal(entry.resolutionPublishedAt != null, true);
  store = JSON.parse(readFileSync(join(mock, "github-store.json"), "utf8"));
  const issue = Object.values(store.issues)[0];
  assert.equal(issue.state, "CLOSED");
  assert.equal(issue.comments.length, 1, "cross-run retry does not re-post the resolution comment");
  assert.equal(issue.comments[0].body.includes("run: run-b"), true,
    "the posted comment is the transition-time payload");
  assert.equal(issue.comments[0].body.includes("run-b-later"), false);
  rmSync(d, { recursive: true, force: true });
});

test("the durable footer carries the issue number across runs", () => {
  const d = dir();
  const mock = join(d, "mock");
  seedPassing(d, { overrides: { differential: { pass: false, differences: { basic: {} } } } });
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "semantic-drift", pass: false, runId: "run-a" });
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const key = Object.keys(read(d, "drift-state.json").keys)[0];

  // Simulate the publish having learned the issue: move the mock issue to
  // number 42 under a non-matching key (so search-by-key cannot find it),
  // patch the packet footer with github.issue, then drop the sidecar —
  // only the rebuilt footer pointer can locate the issue.
  const storePath = join(mock, "github-store.json");
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  store.issues["42"] = { ...store.issues["1"], key: "unrelated", body: "(older observation)" };
  delete store.issues["1"];
  writeFileSync(storePath, JSON.stringify(store, null, 2));
  const issueFile = join(d, "issues-open", readdirSync(join(d, "issues-open"))[0]);
  const text = readFileSync(issueFile, "utf8");
  const footer = JSON.parse(text.match(/<!-- drift-state:(.*?)-->/s)[1]);
  footer.github = { issue: 42 };
  writeFileSync(issueFile, text.replace(/<!-- drift-state:[\s\S]*?-->/,
    "<!-- drift-state:" + JSON.stringify(footer) + " -->"));
  rmSync(join(d, "drift-state.json"));

  // Same drift re-observed on a fresh checkout → the publish path comments
  // the known issue instead of creating a new one.
  run("compat/drift-record.mjs", ["--oracle", "latest", "--publish", "--mock-dir", mock], d);
  const payload = JSON.parse(readFileSync(join(mock, key + ".issue.json"), "utf8"));
  assert.equal(payload.action, "comment");
  assert.equal(payload.issue, 42);
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
  // compatible -> proposed file, and manifest.json is untouched. npm is
  // PATH-stubbed so the apply bundle's lockfile regeneration is hermetic.
  const manifestBefore = readFileSync(join(root, "compat/oracle/manifest.json"), "utf8");
  const d = dir();
  seedPassing(d);
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-1" });
  const stubBin = join(d, "bin");
  mkdirSync(stubBin, { recursive: true });
  const stub = join(stubBin, "npm");
  writeFileSync(stub, "#!/bin/sh\nprintf '{\"stubbedLockfile\": true}\\n' > package-lock.json\n");
  chmodSync(stub, 0o755);
  run("compat/update-candidate.mjs", ["--oracle", "latest"], d,
    { PATH: stubBin + ":" + process.env.PATH });
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

// docs-watch: volatile chrome (A/B scripts, timestamps, footer text) must not
// produce a "changed" signal; only normalized main-content sections are
// hashed, and a real content edit reports the exact section. Fully fixture
// driven — no network.
function docsWatchFixture(stepsBody, stamp, noise) {
  return `<!doctype html><html><head><script>var ab_bucket="${noise}";</script>`
    + `<style>.x{color:red}</style></head><body data-exp="${noise}">`
    + `<nav>site nav ${noise}</nav><header>page header</header>`
    + `<main><p>Intro text.</p>`
    + `<h2>Steps and retries</h2><p>Default retry limit: ${stepsBody}.</p>`
    + `<time datetime="${stamp}">Last updated ${stamp}</time>`
    + `<h2>Rollbacks</h2><p>Handlers run in reverse step-start order.</p>`
    + `<footer>Feedback widget rev ${noise} · rendered ${stamp}</footer>`
    + `</main></body></html>`;
}

const docsWatchUrls = [
  "https://docs.example.com/workflows/steps/",
  "https://docs.example.com/workflows/events/",
];

function writeDocsWatchFixtures(fixturesDir, stepsBody, stamp, noise) {
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, "docs-example-com-workflows-steps.html"),
    docsWatchFixture(stepsBody, stamp, noise));
  writeFileSync(join(fixturesDir, "docs-example-com-workflows-events.html"),
    `<html><body><main><h2>Events</h2><p>waitForEvent times out after 24h.</p></main></body></html>`);
}

function docsWatchArgs(d) {
  const fixtures = join(d, "fixtures");
  writeFileSync(join(d, "VERSION.md"), "# refs\n- " + docsWatchUrls.join("\n- ") + "\n");
  return [
    "--source-file", join(d, "VERSION.md"),
    "--baseline", join(d, "baseline.json"),
    "--fixture-dir", fixtures,
  ];
}

test("docs-watch ignores volatile markup and reports changed sections", () => {
  const d = dir();
  writeDocsWatchFixtures(join(d, "fixtures"), "five", "2026-09-01", "alpha");
  const args = docsWatchArgs(d);
  let r = run("compat/docs-watch.mjs", [...args, "--update-baseline"], d);
  assert.equal(r.status, 0, r.stderr);
  let rec = read(d, "docs-watch.json");
  assert.equal(rec.changed.length, 0);
  const baselineSources = JSON.parse(readFileSync(join(d, "baseline.json"), "utf8")).sources;
  assert.equal(baselineSources.length, 2, "baseline stores one entry per source url");
  assert.ok(baselineSources[0].sections["steps-and-retries"], "baseline stores per-section hashes");

  // Volatile-only refresh: new timestamp, different A/B script/nav/footer
  // text, changed chrome attributes — no section body changed.
  writeDocsWatchFixtures(join(d, "fixtures"), "five", "2026-09-20", "beta");
  r = run("compat/docs-watch.mjs", args, d);
  assert.equal(r.status, 0, r.stderr);
  rec = read(d, "docs-watch.json");
  assert.equal(rec.changed.length, 0, "timestamps/A-B markup must not flag the page");
  assert.equal(rec.investigationRequired, false);

  // A real edit inside one section: the page is flagged and the changed
  // section is named.
  writeDocsWatchFixtures(join(d, "fixtures"), "six", "2026-09-20", "gamma");
  r = run("compat/docs-watch.mjs", args, d);
  rec = read(d, "docs-watch.json");
  assert.deepEqual(rec.changed, ["https://docs.example.com/workflows/steps/"]);
  assert.deepEqual(rec.changedSections, [
    { url: "https://docs.example.com/workflows/steps/", section: "steps-and-retries", kind: "changed" },
  ], "the record names the section that changed");
  assert.equal(rec.investigationRequired, true);
  assert.equal(rec.sources[0].scope, "main");
  rmSync(d, { recursive: true, force: true });
});

// update-candidate: on a compatible verdict the bundle is prepared in an
// isolated copy — the repo's package.json/lockfile/manifest are never
// touched. `npm` is PATH-stubbed so lockfile regeneration is hermetic.
function writeNpmStub(binDir, body) {
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "npm");
  writeFileSync(stub, "#!/bin/sh\n" + body + "\n");
  chmodSync(stub, 0o755);
  return binDir;
}

test("update-candidate emits an isolated apply bundle and reviewable patch", () => {
  const d = dir();
  seedPassing(d); // candidate tuple differs from the pinned manifest
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-1" });
  const stubBin = writeNpmStub(join(d, "bin"),
    "printf '{\"stubbedLockfile\": true}\\n' > package-lock.json");
  const pkgBefore = readFileSync(join(root, "package.json"), "utf8");
  const lockBefore = readFileSync(join(root, "package-lock.json"), "utf8");
  const manifestBefore = readFileSync(join(root, "compat/oracle/manifest.json"), "utf8");

  const r = run("compat/update-candidate.mjs", ["--oracle", "latest"], d,
    { PATH: stubBin + ":" + process.env.PATH });
  assert.equal(r.status, 0, r.stderr);
  const proposal = read(d, "update-candidate-latest.json");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.apply.status, "generated");
  assert.equal(proposal.apply.lockfile, "regenerated");

  const applyDir = join(d, "update-candidate-apply");
  const appliedPkg = JSON.parse(readFileSync(join(applyDir, "package.json"), "utf8"));
  assert.equal(appliedPkg.devDependencies.wrangler, "4.142.0");
  assert.equal(appliedPkg.devDependencies["@cloudflare/workers-types"], "5.20260928.1");
  assert.equal(appliedPkg.devDependencies.workerd, "1.20260928.1");
  assert.match(readFileSync(join(applyDir, "package-lock.json"), "utf8"), /stubbedLockfile/,
    "the bundle's lockfile is the one regenerated inside the isolated copy");
  const appliedManifest = JSON.parse(readFileSync(join(applyDir, "compat/oracle/manifest.json"), "utf8"));
  assert.equal(appliedManifest.wrangler, "4.142.0");

  const patch = readFileSync(join(d, "update-candidate.patch"), "utf8");
  assert.match(patch, /diff --git a\/package\.json b\/package\.json/);
  assert.match(patch, /\+\s+"wrangler": "4\.142\.0"/);
  assert.match(patch, /diff --git a\/package-lock\.json b\/package-lock\.json/);
  assert.match(patch, /diff --git a\/compat\/oracle\/manifest\.json b\/compat\/oracle\/manifest\.json/);

  // The repo working tree is untouched.
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), pkgBefore);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), lockBefore);
  assert.equal(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"), manifestBefore);
  rmSync(d, { recursive: true, force: true });
});

test("update-candidate records lockfile-regeneration failure honestly", () => {
  const d = dir();
  seedPassing(d);
  write(d, "verdict-latest.json", { oracle: "latest", verdict: "compatible", pass: true, runId: "run-1" });
  const stubBin = writeNpmStub(join(d, "bin"), "exit 1");

  const r = run("compat/update-candidate.mjs", ["--oracle", "latest"], d,
    { PATH: stubBin + ":" + process.env.PATH });
  assert.equal(r.status, 0, r.stderr);
  const proposal = read(d, "update-candidate-latest.json");
  assert.equal(proposal.apply.lockfile, "failed");
  assert.ok(proposal.apply.error, "the failure is recorded, not hidden");
  const patch = readFileSync(join(d, "update-candidate.patch"), "utf8");
  assert.match(patch, /a\/package\.json/, "non-lockfile hunks are still emitted");
  assert.doesNotMatch(patch, /a\/package-lock\.json/,
    "a stale copied lockfile never ships in the patch");
  rmSync(d, { recursive: true, force: true });
});
