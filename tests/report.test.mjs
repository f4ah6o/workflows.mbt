import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildResultFingerprint, computeRelevantInputs } from "../compat/coverage-model.mjs";
import { runPinned } from "../compat/run-pinned.mjs";

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
  const candidate = { id: "report-candidate", mode: "pinned", status: "ok" };
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
  write("differential-pinned.json", differential);
  write("verdict-pinned.json", verdict);
  function report() {
    const result = spawnSync(process.execPath, [join(repository, "compat/report.mjs")], {
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
        restrictCatalogToCandidate(f.repository, candidate);
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
      return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 120000 });
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
