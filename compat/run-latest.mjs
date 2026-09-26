import { spawnSync } from "node:child_process";

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const contract = run("compat/oracle/check.mjs", ["--mode", "latest"]);
const differential = run("compat/run-differential.mjs", ["--oracle", "latest"]);
if (contract !== 0 || differential !== 0) process.exitCode = 1;
