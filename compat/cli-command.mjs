import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

function isNpmCli(path) {
  return typeof path === "string"
    && path.split(/[\\/]/).at(-1)?.toLowerCase() === "npm-cli.js"
    && existsSync(path);
}

export function npmCommand(args = [], {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  if (platform !== "win32") return { command: "npm", args };

  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathEntries = (env.PATH ?? env.Path ?? env.path ?? "").split(pathDelimiter).filter(Boolean);
  const candidates = [
    env.npm_execpath,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...pathEntries.map((entry) => join(entry, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const npmCli = candidates.find(isNpmCli);
  if (!npmCli) {
    throw new Error("Unable to locate npm-cli.js; set npm_execpath or install npm next to Node or on PATH");
  }
  return { command: execPath, args: [resolve(npmCli), ...args] };
}

export function packageBinCommand(packageRoot, name, { execPath = process.execPath } = {}) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[name];
  if (typeof bin !== "string") {
    throw new Error(`${packageJson.name ?? packageRoot} does not define a "${name}" executable`);
  }
  return { command: execPath, args: [resolve(packageRoot, bin)] };
}
