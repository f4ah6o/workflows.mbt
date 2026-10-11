import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writePinnedFailure } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PINNED_PHASES = Object.freeze([
  { name: "candidate", script: "compat/candidate.mjs", args: ["--mode", "pinned"] },
  { name: "typecheck", script: "node_modules/typescript/bin/tsc", args: ["-p", "compat/typecheck/tsconfig.json"] },
  { name: "candidate-typecheck", script: "compat/run-typecheck.mjs", args: ["--oracle", "pinned"] },
  { name: "contract", script: "compat/oracle/check.mjs", args: ["--mode", "pinned"] },
  { name: "differential", script: "compat/run-differential.mjs", args: ["--oracle", "pinned"] },
  { name: "verdict", script: "compat/verdict.mjs", args: ["--oracle", "pinned"] },
  { name: "capabilities", script: "compat/check-capabilities.mjs", args: ["--require-pinned"] },
]);

export function runPinned({
  cwd = root,
  env = process.env,
  runId = "pinned-" + new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8),
  spawn = spawnSync,
  readVerdict = (path) => JSON.parse(readFileSync(path, "utf8")),
  recordCandidateFailure = writePinnedFailure,
  output = console,
} = {}) {
  const runEnv = { ...env, WORKFLOWS_MBT_RUN_ID: runId };
  const resultsDir = env.WORKFLOWS_MBT_RESULTS_DIR
    ? resolve(cwd, env.WORKFLOWS_MBT_RESULTS_DIR)
    : join(cwd, "compat-results");
  // Invalidate the previous candidate even if the resolver cannot start.
  recordCandidateFailure(resultsDir, runId, new Error("pinned candidate resolution has not completed"));
  const phases = [];
  for (const phase of PINNED_PHASES) {
    const command = process.execPath;
    const args = [phase.script, ...phase.args];
    const started = Date.now();
    let result;
    try {
      result = spawn(command, args, { cwd, env: runEnv, stdio: "inherit" });
    } catch (error) {
      result = { status: 1, error };
    }
    if (phase.name === "candidate" && (result.error || result.status !== 0)) {
      recordCandidateFailure(resultsDir, runId,
        result.error ?? new Error("pinned candidate phase failed (status " + result.status + ")"));
    }
    phases.push({
      name: phase.name,
      status: result.status ?? 1,
      error: result.error?.message ?? null,
      durationMs: Date.now() - started,
    });
  }

  let verdictStatus = "missing-or-malformed";
  try {
    const verdict = readVerdict(join(resultsDir, "verdict-pinned.json"));
    if (verdict?.oracle === "pinned" && verdict.runId === runId
        && verdict.verdict === "compatible" && verdict.pass === true) {
      verdictStatus = "compatible";
    } else if (verdict?.runId === runId && verdict?.oracle === "pinned") {
      verdictStatus = verdict.verdict === "compatible" ? "invalid-verdict" : (verdict.verdict ?? "invalid-verdict");
    } else {
      verdictStatus = "stale-or-mismatched-verdict";
    }
  } catch {
    verdictStatus = "missing-or-malformed";
  }
  const pass = phases.every((phase) => phase.status === 0) && verdictStatus === "compatible";
  output.log(JSON.stringify({ runId, pass, verdictStatus,
    exits: Object.fromEntries(phases.map((phase) => [phase.name, phase.status])) }));
  return { runId, pass, verdictStatus, phases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!runPinned().pass) process.exitCode = 1;
}
