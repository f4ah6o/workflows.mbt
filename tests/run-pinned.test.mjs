import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinned } from "../compat/candidate.mjs";
import { PINNED_PHASES, runPinned } from "../compat/run-pinned.mjs";

const runId = "pinned-fixture-1";
const goodVerdict = { oracle: "pinned", verdict: "compatible", pass: true, runId };
const quiet = { log() {} };
const fixtureRoot = join(tmpdir(), "workflows-mbt-pinned-fixture");
const fixtureCwd = join(fixtureRoot, "repository");
const fixtureResults = join(fixtureRoot, "evidence");

function fixture({ failedPhase, verdict = goodVerdict, readFailure = false } = {}) {
  const calls = [];
  const result = runPinned({
    cwd: fixtureCwd,
    env: { WORKFLOWS_MBT_RESULTS_DIR: fixtureResults, EXISTING: "yes" },
    runId,
    output: quiet,
    recordCandidateFailure() {},
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const index = calls.length - 1;
      return { status: PINNED_PHASES[index].name === failedPhase ? 1 : 0 };
    },
    readVerdict(path) {
      assert.equal(path, join(fixtureResults, "verdict-pinned.json"));
      if (readFailure) throw new SyntaxError("invalid JSON");
      return verdict;
    },
  });
  return { result, calls };
}

test("pinned pipeline executes every phase with one immutable candidate-bound run ID", () => {
  const { result, calls } = fixture();
  assert.equal(result.pass, true);
  assert.equal(result.verdictStatus, "compatible");
  assert.deepEqual(result.phases.map((phase) => phase.name), PINNED_PHASES.map((phase) => phase.name));
  assert.deepEqual(calls.map((call) => call.command), PINNED_PHASES.map(() => process.execPath));
  assert.deepEqual(calls.map((call) => call.args), [
    ["compat/candidate.mjs", "--mode", "pinned"],
    ["node_modules/typescript/bin/tsc", "-p", "compat/typecheck/tsconfig.json"],
    ["compat/run-typecheck.mjs", "--oracle", "pinned"],
    ["compat/oracle/check.mjs", "--mode", "pinned"],
    ["compat/run-differential.mjs", "--oracle", "pinned"],
    ["compat/verdict.mjs", "--oracle", "pinned"],
    ["compat/check-capabilities.mjs", "--require-pinned"],
  ]);
  for (const call of calls) {
    assert.equal(call.options.env.WORKFLOWS_MBT_RUN_ID, runId);
    assert.equal(call.options.env.EXISTING, "yes");
    assert.equal(call.options.cwd, fixtureCwd);
  }
});

test("failed phases never become success and remaining evidence phases still run", () => {
  for (const phase of PINNED_PHASES) {
    const { result, calls } = fixture({ failedPhase: phase.name });
    assert.equal(result.pass, false, phase.name);
    assert.equal(calls.length, PINNED_PHASES.length);
    assert.equal(result.phases.find((item) => item.name === phase.name).status, 1);
  }
});

test("missing, stale, and inconsistent verdicts fail closed even after zero phase exit codes", () => {
  for (const verdict of [
    { ...goodVerdict, runId: "old-run" },
    { ...goodVerdict, oracle: "latest" },
    { ...goodVerdict, verdict: "semantic-drift", pass: false },
    { ...goodVerdict, pass: false },
    { ...goodVerdict, verdict: "contract-drift" },
    {},
  ]) {
    const { result } = fixture({ verdict });
    assert.equal(result.pass, false);
  }
  assert.equal(fixture({ readFailure: true }).result.verdictStatus, "missing-or-malformed");
});


test("spawn exceptions fail the phase and preserve later phase execution", () => {
  const calls = [];
  const result = runPinned({
    cwd: fixtureCwd, runId, output: quiet,
    recordCandidateFailure() {},
    spawn(_command, _args) {
      const phase = PINNED_PHASES[calls.length];
      calls.push(phase.name);
      if (phase.name === "contract") throw new Error("spawn denied");
      return { status: 0 };
    },
    readVerdict() { return goodVerdict; },
  });
  assert.equal(result.pass, false);
  assert.deepEqual(calls, PINNED_PHASES.map((phase) => phase.name));
  assert.equal(result.phases.find((phase) => phase.name === "contract").error, "spawn denied");
});

test("candidate resolution writes a fresh failure marker before launch and replaces it on spawn failure", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "workflows-mbt-candidate-failure-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const resultsDir = join(scratch, "results");
  const candidatePath = join(resultsDir, "candidate-pinned.json");
  const runId = "candidate-spawn-failure";
  const result = runPinned({
    cwd: scratch,
    env: { WORKFLOWS_MBT_RESULTS_DIR: resultsDir },
    runId,
    output: quiet,
    spawn(_command, args) {
      if (args[0] === "compat/candidate.mjs") {
        assert.equal(existsSync(candidatePath), true);
        const marker = JSON.parse(readFileSync(candidatePath, "utf8"));
        assert.equal(marker.status, "acquisition-failure");
        assert.equal(marker.runId, runId);
        assert.match(marker.error, /resolution has not completed/);
        throw new Error("candidate spawn denied");
      }
      return { status: 0 };
    },
    readVerdict() { return goodVerdict; },
  });

  assert.equal(result.pass, false);
  const marker = JSON.parse(readFileSync(candidatePath, "utf8"));
  assert.equal(marker.status, "acquisition-failure");
  assert.equal(marker.runId, runId);
  assert.equal(marker.error, "candidate spawn denied");
});

test("standalone pinned resolution returns and persists an acquisition failure", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "workflows-mbt-pinned-resolution-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const resultsDir = join(scratch, "results");
  const candidate = await resolvePinned(join(scratch, "missing-repository"), resultsDir);

  assert.equal(candidate.status, "acquisition-failure");
  assert.equal(JSON.parse(readFileSync(join(resultsDir, "candidate-pinned.json"), "utf8")).id, candidate.id);
});
