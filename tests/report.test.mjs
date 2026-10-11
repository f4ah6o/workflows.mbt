import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildResultFingerprint, computeRelevantInputs } from "../compat/coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "wfmbt-report-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const results = join(scratch, "results");
  const inventory = join(scratch, "inventory");
  mkdirSync(results);
  cpSync(join(root, "compat/inventory"), inventory, { recursive: true });
  const write = (name, value) => writeFileSync(join(results, name), JSON.stringify(value));
  const candidate = { id: "report-candidate", mode: "pinned", status: "ok" };
  const verdict = {
    oracle: "pinned", verdict: "compatible", pass: true, runId: "report-run", candidate,
  };
  const differential = {
    oracle: "pinned", runId: verdict.runId, candidateId: candidate.id,
    checkedAt: new Date().toISOString(), pass: true,
    probes: catalog.probes.filter((probe) => probe.differential !== false).map((probe) => probe.id).sort(),
    differences: {}, probeErrors: {}, sideErrors: {},
    fingerprint: buildResultFingerprint({
      runId: verdict.runId, oracle: "pinned", candidate,
      relevantInputs: computeRelevantInputs(root, candidate, { inventoryDir: inventory }),
      commit: "report-fixture",
    }),
  };
  write("candidate-pinned.json", candidate);
  write("differential-pinned.json", differential);
  write("verdict-pinned.json", verdict);
  function report() {
    const result = spawnSync(process.execPath, [join(root, "compat/report.mjs")], {
      env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: results, WORKFLOWS_MBT_INVENTORY_DIR: inventory },
      encoding: "utf8", timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const markdown = readFileSync(join(results, "report.md"), "utf8");
    return {
      outcome: markdown.split("\n").find((line) => line.startsWith("- pinned oracle:")),
      coverage: JSON.parse(readFileSync(join(results, "coverage.json"), "utf8")),
    };
  }
  return { write, report, inventory, results, verdict, differential };
}

test("pinned report downgrades a compatible verdict after relevant inputs change", (t) => {
  const f = fixture(t);
  const before = f.report();
  assert.match(before.outcome, /verdict \*\*compatible\*\* \(run report-run, candidate report-candidate\)/);
  assert.equal(before.coverage.oracles.pinned.fresh, true);

  appendFileSync(join(f.inventory, "classification.json"), "\n");
  const after = f.report();
  assert.equal(after.coverage.oracles.pinned.fresh, false);
  assert.match(after.outcome, /STALE/);
  assert.doesNotMatch(after.outcome, /compatible/);
});

test("pinned report rejects mismatched and missing verdict identities", (t) => {
  const f = fixture(t);
  for (const patch of [
    { runId: "another-run" }, { runId: null },
    { candidate: { id: "another-candidate" } }, { candidate: {} },
    { oracle: "latest" }, { pass: false },
  ]) {
    f.write("verdict-pinned.json", { ...f.verdict, ...patch });
    const result = f.report();
    assert.equal(result.coverage.oracles.pinned.fresh, true);
    assert.match(result.outcome, /unverified/);
    assert.doesNotMatch(result.outcome, /compatible/);
  }
});

test("pinned report requires measured, fingerprinted evidence", (t) => {
  const f = fixture(t);
  f.write("differential-pinned.json", { ...f.differential, fingerprint: null });
  assert.match(f.report().outcome, /STALE/);
  rmSync(join(f.results, "differential-pinned.json"));
  assert.match(f.report().outcome, /unverified/);
});

test("pinned report retains the no-verdict fallback", (t) => {
  const f = fixture(t);
  rmSync(join(f.results, "verdict-pinned.json"));
  assert.match(f.report().outcome, /contract not run \+ semantic probes pass — no pinned verdict file/);
});
