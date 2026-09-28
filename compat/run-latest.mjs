// Latest-oracle run orchestrator.
//
//   node compat/run-latest.mjs
//
// Phases (all run under one WORKFLOWS_MBT_RUN_ID and one shared candidate):
//   1. compat/candidate.mjs --mode latest --refresh   (resolve @latest ONCE)
//   2. compat/run-typecheck.mjs --oracle latest       (candidate-scoped tsc)
//   3. compat/oracle/check.mjs --mode latest          (contract surface)
//   4. compat/run-differential.mjs --oracle latest    (semantic probes)
//   5. compat/docs-watch.mjs                          (official-doc change watch)
//   6. compat/verdict.mjs --oracle latest             (machine-readable verdict)
//   7. compat/drift-record.mjs --oracle latest        (response packet / state)
//   8. compat/update-candidate.mjs --oracle latest    (verified update candidate)
//
// Phases 2-5 always run — even when an earlier phase failed — so every run
// produces a complete evidence trail instead of silently reusing stale files.
// The verdict classifies compatible / contract-drift / semantic-drift /
// acquisition-failure / toolchain-failure / incomplete-evidence; this script
// exits non-zero unless the verdict is compatible.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = "latest-" + new Date().toISOString().replaceAll(":", "-").replace(/\..*/, "")
  + "-" + Math.random().toString(16).slice(2, 8);
const env = { ...process.env, WORKFLOWS_MBT_RUN_ID: runId, CI: "true" };

function run(script, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env,
    cwd: root,
  });
  const status = result.status ?? 1;
  return { script, args, status, durationMs: Date.now() - started, error: result.error?.message ?? null };
}

console.log("run " + runId + ": resolving upstream candidate once");
const phases = [];
phases.push({ name: "candidate", ...run("compat/candidate.mjs", ["--mode", "latest", "--refresh"]) });
phases.push({ name: "typecheck", ...run("compat/run-typecheck.mjs", ["--oracle", "latest"]) });
phases.push({ name: "contract", ...run("compat/oracle/check.mjs", ["--mode", "latest"]) });
phases.push({ name: "differential", ...run("compat/run-differential.mjs", ["--oracle", "latest"]) });
phases.push({ name: "docs-watch", ...run("compat/docs-watch.mjs", []) });
phases.push({ name: "verdict", ...run("compat/verdict.mjs", ["--oracle", "latest"]) });
phases.push({ name: "response", ...run("compat/drift-record.mjs", ["--oracle", "latest"]) });
phases.push({ name: "update-candidate", ...run("compat/update-candidate.mjs", ["--oracle", "latest"]) });

const summary = Object.fromEntries(phases.map((phase) => [phase.name, phase.status]));
console.log("run " + runId + " phase exits: " + JSON.stringify(summary));
const verdict = phases.find((phase) => phase.name === "verdict");
if (verdict.status !== 0) process.exitCode = 1;
