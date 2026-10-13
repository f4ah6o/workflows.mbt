import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { npmCommand, packageBinCommand } from "../compat/cli-command.mjs";

const root = resolve(import.meta.dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

function tempDir(t) {
  const path = mkdtempSync(join(tmpdir(), "workflows mbt cli "));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function addNpmCli(directory) {
  const path = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(directory, "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(path, "");
  return path;
}

test("POSIX npm commands preserve PATH lookup and argument boundaries", () => {
  const args = ["view", "@example/pkg with spaces@latest", "--json"];
  assert.deepEqual(npmCommand(args, { platform: "linux", env: { PATH: "" } }), {
    command: "npm", args,
  });
});

test("Windows npm commands prefer valid npm_execpath and preserve paths and arguments", (t) => {
  const directory = tempDir(t);
  const nodeDirectory = join(directory, "Node installation with spaces");
  const fallback = addNpmCli(nodeDirectory);
  const npmExecPath = join(directory, "npm installation with spaces", "npm-cli.js");
  mkdirSync(join(directory, "npm installation with spaces"), { recursive: true });
  writeFileSync(npmExecPath, "");
  const args = ["view", "@example/pkg with spaces@latest", "--json"];

  assert.deepEqual(npmCommand(args, {
    platform: "win32",
    execPath: join(nodeDirectory, "node.exe"),
    env: { npm_execpath: npmExecPath, PATH: "" },
  }), {
    command: join(nodeDirectory, "node.exe"),
    args: [resolve(npmExecPath), ...args],
  });
  assert.notEqual(resolve(npmExecPath), fallback);
});

test("Windows npm fallback searches the Node directory and PATH directories", (t) => {
  const directory = tempDir(t);
  const nodeDirectory = join(directory, "Node");
  const nodeNpmCli = addNpmCli(nodeDirectory);
  assert.equal(npmCommand([], {
    platform: "win32",
    execPath: join(nodeDirectory, "node.exe"),
    env: { PATH: "" },
  }).args[0], resolve(nodeNpmCli));

  const pathDirectory = join(directory, "PATH npm with spaces");
  const pathNpmCli = addNpmCli(pathDirectory);
  assert.equal(npmCommand([], {
    platform: "win32",
    execPath: join(directory, "Node without npm", "node.exe"),
    env: { PATH: [join(directory, "empty"), pathDirectory].join(";") },
  }).args[0], resolve(pathNpmCli));
});

test("Windows npm resolution fails clearly when no npm CLI is available", (t) => {
  const directory = tempDir(t);
  assert.throws(() => npmCommand([], {
    platform: "win32",
    execPath: join(directory, "node.exe"),
    env: { PATH: "" },
  }), /Unable to locate npm-cli\.js/);
});

test("package CLI resolution supports string and named bin fields with spaces", (t) => {
  const directory = tempDir(t);
  const packageRoot = join(directory, "cf package with spaces");
  mkdirSync(packageRoot);
  for (const bin of ["./bin/cf", { cf: "./bin/cf", cloudflare: "./bin/cf" }]) {
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "cf", bin }));
    assert.deepEqual(packageBinCommand(packageRoot, "cf", { execPath: "node" }), {
      command: "node",
      args: [resolve(packageRoot, "./bin/cf")],
    });
  }
});

test("TypeScript CLI runs through Node", () => {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  assert.match(run(process.execPath, [tsc, "--version"]).stdout, /Version \d+\.\d+/);
});

test("cf package CLI runs through Node", () => {
  const command = packageBinCommand(join(root, "node_modules", "cf"), "cf");
  const result = run(command.command, [...command.args, "--help"]);
  assert.match(result.stdout + result.stderr, /Usage|Commands|cloudflare/i);
});

test("npm CLI runs through the shared command resolver", () => {
  const command = npmCommand(["--version"]);
  assert.match(run(command.command, command.args).stdout, /^\d+\.\d+\.\d+/);
});
