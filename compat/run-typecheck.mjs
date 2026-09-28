// Candidate-scoped typecheck — compiles the typecheck fixture against the
// shared run candidate's @cloudflare/workers-types instead of the repository's
// pinned node_modules.
//
//   node compat/run-typecheck.mjs --oracle latest [--candidate <candidate.json>]
//
// Writes compat-results/typecheck-<oracle>.json. A tsc diagnostics failure is
// contract-level evidence (the source no longer typechecks against upstream
// types) — a verdict classifies it as contract drift. A spawn/toolchain error
// is recorded as a toolchain failure instead.

import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateUsable, loadCandidate, resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });

const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "latest";
if (!["pinned", "latest"].includes(oracle)) throw new Error("oracle must be pinned or latest");
const candidateIndex = process.argv.indexOf("--candidate");
const candidateArg = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : null;
const runId = process.env.WORKFLOWS_MBT_RUN_ID ?? "typecheck-" + oracle + "-" + Date.now();

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const candidate = await loadCandidate(oracle, { candidatePath: candidateArg, resultsDir });
const outPath = join(resultsDir, "typecheck-" + oracle + ".json");

if (!candidateUsable(candidate)) {
  const result = {
    oracle,
    runId,
    checkedAt: new Date().toISOString(),
    commit: gitCommit(),
    candidateId: candidate.id ?? null,
    phaseStatus: "upstream-acquisition-failure",
    error: candidate.error ?? "candidate not usable",
    pass: false,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

// A generated tsconfig redirects @cloudflare/workers-types to the candidate's
// isolated install; everything else (fixture files, strictness, the local
// cloudflare:workers shim types) stays identical to the pinned typecheck.
const baseConfig = JSON.parse(readFileSync(join(root, "compat/typecheck/tsconfig.json"), "utf8"));
const typesRoot = candidate.paths.workersTypesPkg;
const generated = {
  ...baseConfig,
  compilerOptions: {
    ...baseConfig.compilerOptions,
    paths: {
      ...(baseConfig.compilerOptions?.paths ?? {}),
      "@cloudflare/workers-types": [join(typesRoot, "index.d.ts")],
      "@cloudflare/workers-types/*": [join(typesRoot, "*")],
    },
  },
};
const configPath = join(resultsDir, `tsconfig-${oracle}.json`);
writeFileSync(configPath, JSON.stringify({
  ...generated,
  files: generated.files.map((f) => join(root, "compat/typecheck", f)),
}, null, 2) + "\n");

const tsc = process.platform === "win32"
  ? join(root, "node_modules/.bin/tsc.cmd")
  : join(root, "node_modules/.bin/tsc");
const started = Date.now();
const proc = spawnSync(tsc, ["-p", configPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 120000,
});
const output = [proc.stdout, proc.stderr].filter(Boolean).join("\n");
const diagnostics = output
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /error TS\d+/.test(line));

const result = {
  oracle,
  runId,
  checkedAt: new Date().toISOString(),
  commit: gitCommit(),
  candidateId: candidate.id,
  versions: candidate.versions,
  durationMs: Date.now() - started,
  phaseStatus: proc.error ? "toolchain-failure" : null,
  error: proc.error ? String(proc.error?.message ?? proc.error) : null,
  diagnostics,
  pass: proc.error == null && proc.status === 0,
};
if (result.phaseStatus == null) delete result.phaseStatus;
if (result.error == null) delete result.error;
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({
  oracle,
  pass: result.pass,
  diagnostics: diagnostics.length,
  firstDiagnostics: diagnostics.slice(0, 10),
}, null, 2));
if (!result.pass) process.exitCode = 1;
