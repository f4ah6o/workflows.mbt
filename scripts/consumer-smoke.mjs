// Clean-consumer smoke test — proves the packaged runtime works on a machine
// with no repository checkout and no MoonBit toolchain.
//
//   node scripts/consumer-smoke.mjs [--tarball path.tgz]
//
// Without --tarball it runs `npm pack` first. The journey under test:
//   1. extract the artifact into a clean temp dir
//   2. npm ci --omit=dev                    (production deps only)
//   3. workflows doctor on cloudflare.config.ts (outside the installed package)
//   4. workflows dev + /create -> suspended -> SIGKILL -> restart -> complete
//   5. npm install <tgz> into a second dir -> `workflows --version` via bin
//
// Steps 2+ run with a PATH that has no MoonBit toolchain, npm globals, or
// cf/wrangler — only the Node toolchain — so passing proves the artifact is
// self-contained on the prebuilt kernel and production config dependencies.

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = dirname(process.execPath);

// The consumer environment: Node + system tools only. Deliberately drops
// ~/.moon/bin (MoonBit toolchain) and any repo-local node_modules/.bin so a
// missing prebuilt kernel or hidden checkout dependency cannot pass silently.
const consumerEnv = {
  ...process.env,
  PATH: `${nodeBin}:/usr/bin:/bin`,
  CI: "true",
};

function run(command, args, { cwd, env = consumerEnv } = {}) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function startDev(args, label) {
  const detached = process.platform !== "win32";
  const child = spawn(process.execPath, args, {
    env: consumerEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.smokeOutput = () => output;
  child.smokeDetached = detached;
  child.smokeLabel = label;
  return child;
}

function signalTree(child, signal) {
  if (child.smokeDetached && child.pid != null) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode == null) child.kill(signal);
}

async function stop(child, signal = "SIGTERM") {
  if (!child) return;
  signalTree(child, signal);
  await Promise.race([new Promise((r) => child.once("exit", r)), delay(4000)]);
  if (child.exitCode == null) signalTree(child, "SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitReady(port, child, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`${label} exited before ready\n${child.smokeOutput().slice(-4000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`${label} did not become ready\n${child.smokeOutput().slice(-4000)}`);
}

async function status(port, id) {
  const response = await fetch(
    `http://127.0.0.1:${port}/status?id=${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error(`status failed: HTTP ${response.status}`);
  return response.json();
}

async function waitStatus(port, id, wanted, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await status(port, id);
    if (Array.isArray(wanted) ? wanted.includes(last.status) : last.status === wanted) {
      return last;
    }
    await delay(150);
  }
  throw new Error(
    `instance ${id} did not reach ${JSON.stringify(wanted)} (last ${JSON.stringify(last)})`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(`consumer smoke failed: ${message}`);
}

const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-consumer-"));
let tarball = null;
const tarballIndex = process.argv.indexOf("--tarball");
if (tarballIndex >= 0) tarball = resolve(process.argv[tarballIndex + 1]);

try {
  // 1. Produce (or accept) the artifact.
  if (tarball == null) {
    // Packing is a build-side operation: it runs with the full development
    // environment (prepack may need the MoonBit toolchain to build dist/).
    run("npm", ["pack", "--pack-destination", temp], { cwd: root, env: process.env });
    tarball = join(
      temp,
      readdirSync(temp).find((name) => name.endsWith(".tgz")),
    );
  }
  assert(existsSync(tarball), `tarball not found: ${tarball}`);
  console.log(`[consumer] artifact: ${tarball}`);

  // 2. Extract into a clean dir and install production deps only.
  const extractDir = join(temp, "extracted");
  mkdirSync(extractDir);
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const pkgDir = join(extractDir, "package");

  for (const required of [
    "dist/workflows_core.mjs",
    "host/cli.mjs",
    "compat/cloudflare-workers/index.mjs",
    "npm-shrinkwrap.json",
  ]) {
    assert(existsSync(join(pkgDir, required)), `artifact is missing ${required}`);
  }
  for (const excluded of ["tests", "issues", ".github", "node_modules"]) {
    assert(!existsSync(join(pkgDir, excluded)), `artifact must not contain ${excluded}`);
  }
  // `files` negations must keep gitignored runtime state (SQLite instance DBs,
  // wrangler caches, local secrets) out of the tarball even when a developer
  // ran `doctor`/`dev` in the checkout before packing.
  const leakedState = run("find", [
    pkgDir,
    "-name", ".workflows",
    "-o", "-name", ".wrangler",
    "-o", "-name", "*.db",
    "-o", "-name", ".dev.vars*",
    "-o", "-name", ".env*",
  ]).trim();
  assert(
    leakedState === "",
    `artifact must not ship runtime state:\n${leakedState}`,
  );
  console.log("[consumer] artifact contents ok (prebuilt kernel present, dev files absent)");

  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: pkgDir });
  console.log("[consumer] npm ci --omit=dev ok (deterministic via npm-shrinkwrap.json)");

  // 3. Consumer project: an ordinary Cloudflare Workflows app copied out of
  //    the artifact's examples/, not the repository's test fixtures.
  const appDir = join(temp, "consumer-app");
  cpSync(join(pkgDir, "examples/basic"), appDir, { recursive: true });
  const consumerConfig = join(appDir, "cloudflare.config.ts");
  const consumerStorage = join(temp, "consumer.sqlite");

  const doctor = run(
    process.execPath,
    [join(pkgDir, "host/cli.mjs"), "doctor", "--config", consumerConfig,
     "--storage", consumerStorage],
  );
  assert(/doctor: all checks passed/.test(doctor), `doctor failed:\n${doctor}`);
  console.log("[consumer] workflows doctor: cloudflare.config.ts passed outside installed package");

  // 4. dev -> create -> suspend -> SIGKILL -> restart -> complete.
  const cliArgs = (port) => [
    join(pkgDir, "host/cli.mjs"),
    "dev",
    "--config", consumerConfig,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--storage", consumerStorage,
    "--build-dir", join(temp, "bundles"),
  ];
  const instanceId = `consumer-${Date.now()}`;
  const port = await freePort();
  let child = startDev(cliArgs(port), "consumer dev");
  try {
    await waitReady(port, child, "consumer dev");
    const response = await fetch(`http://127.0.0.1:${port}/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: instanceId, params: { orderId: "A-42" } }),
    });
    assert(response.ok, `create failed: HTTP ${response.status} ${await response.text()}`);

    // Suspend inside step.sleep, then kill the process tree.
    await waitStatus(port, instanceId, "waiting", 20000);
    await stop(child, "SIGKILL");
    console.log("[consumer] SIGKILLed mid-suspension");

    const restartedPort = await freePort();
    child = startDev(cliArgs(restartedPort), "consumer dev (restarted)");
    await waitReady(restartedPort, child, "consumer dev (restarted)");
    const final = await waitStatus(
      restartedPort, instanceId, ["complete", "errored", "terminated"], 30000,
    );
    assert(final.status === "complete", `instance ended as ${final.status}`);
    assert(
      final.output?.receipt?.orderId === "A-42",
      `unexpected output: ${JSON.stringify(final.output)}`,
    );
    console.log("[consumer] restart completed instance from persisted state with expected output");

    // The CLI itself is the operator surface — status must read the same DB.
    const cliStatus = run(
      process.execPath,
      [join(pkgDir, "host/cli.mjs"), "status", "order-workflow", instanceId,
       "--config", consumerConfig, "--storage", consumerStorage],
    );
    assert(JSON.parse(cliStatus).status === "complete", "CLI status disagrees");
    console.log("[consumer] CLI status reports complete from the same storage");
  } finally {
    await stop(child);
  }

  // 5. npm-install path: the same tarball as a project dependency.
  const installDir = join(temp, "consumer-install");
  mkdirSync(installDir);
  run("npm", ["init", "-y"], { cwd: installDir });
  run("npm", ["install", tarball, "--no-audit", "--no-fund"], { cwd: installDir });
  const installed = join(installDir, "node_modules", "@f4ah6o", "workflows-mbt");
  assert(
    existsSync(join(installed, "dist", "workflows_core.mjs")),
    "installed package lacks the prebuilt kernel",
  );
  const bin = join(installDir, "node_modules", ".bin", "workflows");
  const version = run(bin, ["--version"]);
  assert(/workflows-mbt \d+\.\d+\.\d+/.test(version), `unexpected --version output: ${version}`);
  console.log(`[consumer] npm install + workflows --version: ${version.trim()}`);

  console.log("consumer-smoke: PASS");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
