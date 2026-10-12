import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildResultFingerprint, computeRelevantInputs } from "../compat/coverage-model.mjs";
import { runPinned } from "../compat/run-pinned.mjs";
import { createPinnedEvidenceRecorder, PINNED_REQUIRED_PHASES } from "../compat/pinned-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const candidatePolicyPath = join(root, "compat/candidate-policy.mjs");
const { differentialProbes } = existsSync(candidatePolicyPath)
  ? await import(pathToFileURL(candidatePolicyPath))
  : { differentialProbes: (catalog) => catalog.probes.filter((probe) => probe.differential !== false).map((probe) => probe.id) };

function fixture(t, { isolated = false, hardlinkNodeModules = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "wfmbt-report-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  let repository = root;
  if (isolated) {
    repository = join(scratch, "repository");
    mkdirSync(repository);
    for (const path of ["compat", "host", "src", "scripts", "fixtures", "package.json",
      "package-lock.json", ".moonbit-toolchain.json", "COMPATIBILITY.md"]) {
      cpSync(join(root, path), join(repository, path), { recursive: true });
    }
    if (hardlinkNodeModules && process.platform !== "win32") {
      execFileSync("cp", ["-al", join(root, "node_modules"), join(repository, "node_modules")]);
    } else {
      symlinkSync(join(root, "node_modules"), join(repository, "node_modules"),
        process.platform === "win32" ? "junction" : "dir");
    }
  }
  const results = join(scratch, "results");
  const inventory = join(scratch, "inventory");
  mkdirSync(results);
  cpSync(join(repository, "compat/inventory"), inventory, { recursive: true });
  const write = (name, value) => writeFileSync(join(results, name), JSON.stringify(value));
  const candidate = { id: "report-candidate", mode: "pinned", status: "ok", runId: "report-run" };
  const verdict = {
    oracle: "pinned", verdict: "compatible", pass: true, runId: "report-run", candidate,
  };
  const differential = {
    oracle: "pinned", runId: verdict.runId, candidateId: candidate.id,
    checkedAt: new Date().toISOString(), pass: true,
    probes: differentialProbes(catalog, candidate).sort(),
    differences: {}, probeErrors: {}, sideErrors: {},
    fingerprint: buildResultFingerprint({
      runId: verdict.runId, oracle: "pinned", candidate,
      relevantInputs: computeRelevantInputs(repository, candidate, { inventoryDir: inventory }),
      commit: "report-fixture",
    }),
  };
  write("candidate-pinned.json", candidate);
  const common = { runId: verdict.runId, candidateId: candidate.id, pass: true,
    checkedAt: new Date().toISOString() };
  write("drift-pinned.json", { ...common, mode: "pinned", versions: {},
    drift: { added: [], removed: [], changed: [] } });
  write("typecheck-pinned.json", { ...common, oracle: "pinned" });
  write("differential-pinned.json", differential);
  write("verdict-pinned.json", verdict);
  const record = createPinnedEvidenceRecorder({ rootDir: repository, resultsDir: results,
    runId: verdict.runId, inventoryDir: inventory });
  for (const name of PINNED_REQUIRED_PHASES) record({ name, status: 0, error: null });
  record({ name: "verdict", status: 0, error: null });
  function report(expectedStatus = 0) {
    const result = spawnSync(process.execPath, [join(repository, "compat/report.mjs")], {
      env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: results, WORKFLOWS_MBT_INVENTORY_DIR: inventory },
      encoding: "utf8", timeout: 120000,
    });
    assert.equal(result.status, expectedStatus, result.stderr + result.stdout);
    const markdown = readFileSync(join(results, "report.md"), "utf8");
    return {
      markdown,
      stderr: result.stderr,
      outcome: markdown.split("\n").find((line) => line.startsWith("- pinned oracle:")),
      coverage: JSON.parse(readFileSync(join(results, "coverage.json"), "utf8")),
    };
  }
  return { write, report, inventory, results, verdict, differential, repository };
}

function restrictCatalogToCandidate(repository, candidate) {
  const path = join(repository, "compat/probes/catalog.json");
  const isolatedCatalog = JSON.parse(readFileSync(path, "utf8"));
  const applicable = new Set(differentialProbes(isolatedCatalog, candidate));
  isolatedCatalog.probes = isolatedCatalog.probes.filter((probe) =>
    probe.differential === false || applicable.has(probe.id));
  writeFileSync(path, JSON.stringify(isolatedCatalog));
}

test("pinned report rejects verdict-only drift substitutions and missing verdict receipts", (t) => {
  const f = fixture(t);
  assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);
  for (const verdict of ["semantic-drift", "contract-drift"]) {
    f.write("verdict-pinned.json", { ...f.verdict, verdict, pass: false });
    assert.match(f.report().outcome, /unverified/);
  }
  f.write("verdict-pinned.json", f.verdict);
  const record = JSON.parse(readFileSync(join(f.results, "run-pinned.json"), "utf8"));
  for (const patch of ["missing-receipt", "missing-hash", "failed-generator"]) {
    const changed = structuredClone(record);
    if (patch === "missing-receipt") changed.phases = changed.phases.filter((p) => p.name !== "verdict");
    if (patch === "missing-hash") delete changed.phases.find((p) => p.name === "verdict").outputHash;
    if (patch === "failed-generator") changed.phases.find((p) => p.name === "verdict").status = 1;
    f.write("run-pinned.json", changed);
    assert.match(f.report().outcome, /unverified/);
  }
  f.write("run-pinned.json", record);
  assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);
});

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
  assert.match(f.report().outcome, /contract clean \+ semantic probes pass — no pinned verdict file/);
});

test("pinned report invalidates every contract and typecheck input independently", (t) => {
  const f = fixture(t, { isolated: true });
  assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);
  for (const relative of [
    "compat/oracle/manifest.json", "compat/oracle/api-surface.json",
    "compat/oracle/wrangler-schema.json", "compat/typecheck/main.ts",
    "compat/typecheck/tsconfig.json", "compat/typecheck/worker-configuration.d.ts",
    "package-lock.json", "compat/oracle/check.mjs", "compat/run-typecheck.mjs",
    "compat/cli-command.mjs",
  ]) {
    const path = join(f.repository, relative);
    const original = readFileSync(path);
    appendFileSync(path, "\n");
    const result = f.report();
    assert.equal(result.coverage.oracles.pinned.fresh, false, relative);
    assert.match(result.outcome, /STALE/, relative);
    assert.doesNotMatch(result.outcome, /compatible/, relative);
    writeFileSync(path, original);
    assert.match(f.report().outcome, /verdict \*\*compatible\*\*/, relative);
  }
});

test("legacy fingerprints without verification inputs are stale, not backfilled", (t) => {
  const f = fixture(t);
  delete f.differential.fingerprint.relevantInputs.verificationSourceHash;
  f.write("differential-pinned.json", f.differential);
  assert.match(f.report().outcome, /STALE/);
});

test("a successful pinned run followed by candidate failure cannot reuse compatible evidence", (t) => {
  const f = fixture(t, { isolated: true, hardlinkNodeModules: true });
  const read = (name) => JSON.parse(readFileSync(join(f.results, name), "utf8"));
  const run = (runId) => runPinned({
    cwd: f.repository,
    env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: f.results,
      WORKFLOWS_MBT_INVENTORY_DIR: f.inventory },
    runId,
    output: { log() {} },
    spawn(command, args, options) {
      const script = args[0];
      if (["compat/run-typecheck.mjs", "compat/oracle/check.mjs", "compat/run-differential.mjs"].includes(script)) {
        const candidate = read("candidate-pinned.json");
        if (candidate.status !== "ok") return { status: 1 };
        const common = {
          runId,
          candidateId: candidate.id,
          pass: true,
          checkedAt: new Date().toISOString(),
        };
        // Hermetic successful oracle evidence; acquisition and aggregation run for real.
        if (script === "compat/run-typecheck.mjs") f.write("typecheck-pinned.json", common);
        if (script === "compat/oracle/check.mjs") f.write("drift-pinned.json", {
          ...common,
          mode: "pinned",
          versions: candidate.versions ?? {},
          drift: { added: [], removed: [], changed: [] },
        });
        if (script === "compat/run-differential.mjs") f.write("differential-pinned.json", {
          ...f.differential,
          ...common,
          probes: differentialProbes(catalog, candidate).sort(),
          fingerprint: buildResultFingerprint({ runId, oracle: "pinned", candidate,
            relevantInputs: computeRelevantInputs(f.repository, candidate, { inventoryDir: f.inventory }) }),
        });
        return { status: 0 };
      }
      if (!["compat/candidate.mjs", "compat/verdict.mjs"].includes(script)) return { status: 0 };
      const result = spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 120000 });
      if (script === "compat/candidate.mjs" && result.status === 0) {
        restrictCatalogToCandidate(f.repository, read("candidate-pinned.json"));
      }
      return result;
    },
  });
  assert.equal(run("first-success").pass, true);
  assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);

  const path = join(f.repository, "compat/oracle/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, cf: "0.0.0-not-installed" }));
  const failed = run("second-failure");
  assert.equal(failed.pass, false);
  for (const phase of ["candidate-typecheck", "contract", "differential"]) {
    assert.equal(failed.phases.find((item) => item.name === phase).status, 1, phase);
  }
  assert.equal(read("candidate-pinned.json").status, "acquisition-failure");
  assert.equal(read("candidate-pinned.json").runId, "second-failure");
  assert.equal(read("verdict-pinned.json").verdict, "upstream-acquisition-failure");
  assert.equal(read("verdict-pinned.json").runId, "second-failure");
  assert.doesNotMatch(f.report().outcome, /compatible/);
});

for (const name of ["drift-pinned.json", "typecheck-pinned.json"]) {
  test("pinned report rejects missing " + name + " after success", (t) => {
    const f = fixture(t);
    assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);
    rmSync(join(f.results, name));
    const result = f.report();
    assert.equal(result.coverage.oracles.pinned.fresh, true);
    assert.match(result.outcome, /unverified/);
    assert.doesNotMatch(result.outcome, /compatible/);
  });
}

test("pinned report rejects mismatched phase identities and failed process receipts", (t) => {
  const f = fixture(t);
  for (const name of ["drift-pinned.json", "typecheck-pinned.json"]) {
    const original = JSON.parse(readFileSync(join(f.results, name), "utf8"));
    for (const patch of [{ runId: "old-run" }, { runId: null }, { candidateId: "other" }, { pass: false }]) {
      f.write(name, { ...original, ...patch });
      assert.match(f.report().outcome, /unverified/);
    }
    f.write(name, original);
  }
  const receipts = JSON.parse(readFileSync(join(f.results, "run-pinned.json"), "utf8"));
  receipts.phases.find((p) => p.name === "typecheck").status = 1;
  f.write("run-pinned.json", receipts);
  assert.match(f.report().outcome, /unverified/);
});

for (const failedPhase of ["candidate-typecheck", "typecheck", "capabilities", "missing-typecheck-run-id"]) {
  test("pinned verdict fails closed when " + failedPhase + " fails without an output", (t) => {
    const f = fixture(t);
    const runId = "failed-" + failedPhase;
    const candidate = { ...f.verdict.candidate, runId };
    const result = runPinned({
      cwd: root, runId,
      env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: f.results, WORKFLOWS_MBT_INVENTORY_DIR: f.inventory },
      output: { log() {} },
      spawn(command, args, options) {
        const script = args[0];
        if (script === "compat/candidate.mjs") f.write("candidate-pinned.json", candidate);
        const output = { "compat/run-typecheck.mjs": "typecheck-pinned.json",
          "compat/oracle/check.mjs": "drift-pinned.json", "compat/run-differential.mjs": "differential-pinned.json" }[script];
        if (output) {
          if (failedPhase === "candidate-typecheck" && script === "compat/run-typecheck.mjs") {
            rmSync(join(f.results, output));
            return { status: 1 };
          }
          const previous = JSON.parse(readFileSync(join(f.results, output), "utf8"));
          f.write(output, { ...previous,
            runId: failedPhase === "missing-typecheck-run-id" && output === "typecheck-pinned.json" ? null : runId });
        }
        if (script === "compat/verdict.mjs") {
          return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 120000 });
        }
        if (failedPhase === "typecheck" && script === "node_modules/typescript/bin/tsc") return { status: 1 };
        if (failedPhase === "capabilities" && script === "compat/check-capabilities.mjs") return { status: 1 };
        return { status: 0 };
      },
    });
    assert.equal(result.pass, false);
    const verdict = JSON.parse(readFileSync(join(f.results, "verdict-pinned.json"), "utf8"));
    assert.equal(verdict.pass, false);
    assert.equal(verdict.verdict, failedPhase === "typecheck" ? "local-runtime-failure" : "incomplete-evidence");
    assert.doesNotMatch(f.report().outcome, /compatible/);
  });
}

for (const [driftPhase, probe] of [["contract", null], ["differential", "binding-create-batch"], ["differential", "basic"]]) {
  test("pinned report preserves fresh, complete " + driftPhase + " drift evidence" + (probe ? " for " + probe : ""), (t) => {
    const f = fixture(t);
    assert.match(f.report().outcome, /verdict \*\*compatible\*\*/);
    for (const name of ["candidate", "typecheck", "drift", "differential", "verdict", "run"]) {
      rmSync(join(f.results, name + "-pinned.json"));
    }
    const expectedReportStatus = probe === "basic" ? 1 : 0;
    const runId = "observed-" + driftPhase + "-drift";
    const candidate = { ...f.verdict.candidate, runId };
    const common = { runId, candidateId: candidate.id, pass: true, checkedAt: new Date().toISOString() };
    const result = runPinned({
      cwd: root, runId,
      env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: f.results, WORKFLOWS_MBT_INVENTORY_DIR: f.inventory },
      output: { log() {} },
      spawn(command, args, options) {
        const script = args[0];
        if (script === "compat/candidate.mjs") f.write("candidate-pinned.json", candidate);
        if (script === "compat/run-typecheck.mjs") f.write("typecheck-pinned.json", { ...common, oracle: "pinned" });
        if (script === "compat/oracle/check.mjs") {
          const pass = driftPhase !== "contract";
          f.write("drift-pinned.json", { ...common, mode: "pinned", pass, versions: {},
            drift: { added: [], removed: pass ? [] : ["WorkflowStep.do"], changed: [] } });
          return { status: pass ? 0 : 1 };
        }
        if (script === "compat/run-differential.mjs") {
          const pass = driftPhase !== "differential";
          f.write("differential-pinned.json", { ...f.differential, ...common, pass,
            differences: pass ? {} : { [probe]: { expected: "upstream", actual: "local" } },
            fingerprint: buildResultFingerprint({ runId, oracle: "pinned", candidate,
              relevantInputs: computeRelevantInputs(root, candidate, { inventoryDir: f.inventory }) }) });
          return { status: pass ? 0 : 1 };
        }
        if (script === "compat/verdict.mjs" || (script === "compat/check-capabilities.mjs" && probe === "basic")) {
          return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 120000 });
        }
        if (script === "compat/check-capabilities.mjs" && driftPhase === "differential") return { status: 1 };
        return { status: 0 };
      },
    });
    assert.equal(result.pass, false);
    assert.equal(result.phases.find((phase) => phase.name === driftPhase).status, 1);
    const verdictBytes = readFileSync(join(f.results, "verdict-pinned.json"));
    const verdict = JSON.parse(verdictBytes);
    const classification = driftPhase === "contract" ? "contract-drift" : "semantic-drift";
    assert.equal(verdict.verdict, classification);
    assert.equal(verdict.pass, false);
    const report = f.report(expectedReportStatus);
    if (probe === "basic") {
      assert.equal(result.phases.find((phase) => phase.name === "capabilities").status, 1);
      assert.equal(report.coverage.status, "INVALID");
      assert.match(report.stderr, /claims pinned_differential/);
      assert.match(report.markdown, /Coverage: \*\*INVALID\*\*/);
      assert.doesNotMatch(report.markdown, /verdict \*\*compatible\*\*/);
    } else {
      assert.equal(report.coverage.oracles.pinned.fresh, true);
    }
    assert.ok(report.outcome.includes("verdict **" + classification + "**"), report.outcome);

    const changedClassification = classification === "contract-drift" ? "semantic-drift" : "contract-drift";
    f.write("verdict-pinned.json", { ...verdict, verdict: changedClassification });
    assert.match(f.report(expectedReportStatus).outcome, /unverified/);
    writeFileSync(join(f.results, "verdict-pinned.json"), verdictBytes);
    assert.ok(f.report(expectedReportStatus).outcome.includes("verdict **" + classification + "**"));

    f.write("verdict-pinned.json", { ...verdict, verdict: "compatible", pass: true });
    assert.match(f.report(expectedReportStatus).outcome, /unverified/);
    writeFileSync(join(f.results, "verdict-pinned.json"), verdictBytes);
    const path = join(f.results, driftPhase === "contract" ? "drift-pinned.json" : "differential-pinned.json");
    const original = readFileSync(path);
    appendFileSync(path, "\n");
    assert.match(f.report(expectedReportStatus).outcome, /unverified/);
    writeFileSync(path, original);
    const typecheck = readFileSync(join(f.results, "typecheck-pinned.json"));
    rmSync(join(f.results, "typecheck-pinned.json"));
    assert.match(f.report(expectedReportStatus).outcome, /unverified/);
    if (probe === "basic") {
      writeFileSync(join(f.results, "typecheck-pinned.json"), typecheck);
      appendFileSync(join(f.inventory, "classification.json"), "\n");
      assert.match(f.report(1).outcome, /STALE/);
      writeFileSync(join(f.results, "verdict-pinned.json"), "not JSON");
      assert.match(f.report(1).outcome, /unverified/);
    }
  });
}
