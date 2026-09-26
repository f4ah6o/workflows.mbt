import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("moon", ["build", "--target", "js", "--release"], {
  cwd: root,
  stdio: "inherit",
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const candidates = walk(join(root, "_build"))
  .filter((path) => extname(path) === ".js")
  .filter((path) => readFileSync(path, "utf8").includes("wf_step_key"));

if (candidates.length === 0) {
  throw new Error("MoonBit build produced no JS foreign_library containing wf_step_key");
}

candidates.sort((a, b) => a.length - b.length);
const targetDir = join(root, "dist");
mkdirSync(targetDir, { recursive: true });
const target = join(targetDir, "workflows_core.mjs");
rmSync(target, { force: true });
cpSync(candidates[0], target);
console.log(`MoonBit kernel: ${candidates[0]} -> ${target}`);
