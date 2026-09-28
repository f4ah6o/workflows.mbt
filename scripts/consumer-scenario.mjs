// Practical consumer scenario — proves a real vertical beyond the probe
// catalog: an ordinary Cloudflare Workflow that calls an external HTTP
// service with a business idempotency key, retries a 5xx, waits for an
// external approval event, is SIGKILLed twice (once after the side effect was
// applied downstream but before the step result was persisted, once while
// parked on waitForEvent), restarts cleanly, and completes without a
// duplicate downstream effect.
//
//   node scripts/consumer-scenario.mjs [--tarball path.tgz]
//
// Runs against the packed artifact in a clean temp dir under a PATH with no
// MoonBit toolchain — the consumer needs only Node. Evidence (kill points,
// call/apply ledger, final status) is written to
// compat-results/scenario-consumer.json.
//
// What this proves, and what it does not:
//   - the runtime is at-least-once: the killed step's callback re-executed
//     (three charge calls for one logical step), and the business idempotency
//     key is what made the downstream apply-once — not the runtime, and not
//     the fallback instance id.
//   - exactly-once external effects are NOT claimed anywhere in the evidence.

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = dirname(process.execPath);
const resultsDir = process.env.WORKFLOWS_MBT_RESULTS_DIR
  ? resolve(process.env.WORKFLOWS_MBT_RESULTS_DIR)
  : join(root, "compat-results");
mkdirSync(resultsDir, { recursive: true });

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

function startProcess(args, label) {
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

async function waitUrl(url, child, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`${label} exited before ready\n${child.smokeOutput().slice(-4000)}`);
    }
    try {
      const response = await fetch(url);
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

async function waitStatus(port, id, wanted, timeoutMs = 60000) {
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

async function serviceStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/stats`);
  if (!response.ok) throw new Error(`stats failed: HTTP ${response.status}`);
  return response.json();
}

async function waitCalls(port, route, count, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await serviceStats(port);
    if ((stats.calls[route] ?? 0) >= count) return stats;
    await delay(120);
  }
  throw new Error(`service did not observe ${count} ${route} calls in time`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`consumer scenario failed: ${message}`);
}

const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-scenario-"));
let tarball = null;
const tarballIndex = process.argv.indexOf("--tarball");
if (tarballIndex >= 0) tarball = resolve(process.argv[tarballIndex + 1]);

const evidence = {
  scenario: "external-side-effect-retry-wait-restart-complete",
  startedAt: new Date().toISOString(),
  killPoints: [],
  expectations: {
    atLeastOnceRuntime: true,
    exactlyOnceExternalEffect: false,
    dedupKey: "business orderId, not the runtime instance/step id",
  },
};

let service = null;
let dev = null;
try {
  if (tarball == null) {
    run("npm", ["pack", "--pack-destination", temp], { cwd: root, env: process.env });
    tarball = join(temp, readdirSync(temp).find((name) => name.endsWith(".tgz")));
  }
  assert(existsSync(tarball), `tarball not found: ${tarball}`);
  console.log(`[scenario] artifact: ${tarball}`);

  const extractDir = join(temp, "extracted");
  mkdirSync(extractDir);
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const pkgDir = join(extractDir, "package");
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: pkgDir });
  console.log("[scenario] npm ci --omit=dev ok");

  const appDir = join(temp, "consumer-app");
  cpSync(join(pkgDir, "examples/scenario"), appDir, { recursive: true });
  const consumerConfig = join(appDir, "wrangler.jsonc");
  const consumerStorage = join(temp, "consumer.sqlite");

  const doctor = run(
    process.execPath,
    [join(pkgDir, "host/cli.mjs"), "doctor", "--config", consumerConfig,
     "--storage", consumerStorage],
  );
  assert(/doctor: all checks passed/.test(doctor), `doctor failed:\n${doctor}`);
  console.log("[scenario] workflows doctor: all checks passed");

  // External test-only service: 503 on first charge call (drives the step's
  // retry policy), holds the first apply response for 2.5s (deterministic
  // window for the post-side-effect kill).
  const servicePort = await freePort();
  service = startProcess(
    [join(appDir, "external-service.mjs"),
     "--port", String(servicePort), "--fail-first", "--hold-ms", "2500"],
    "external service",
  );
  await waitUrl(`http://127.0.0.1:${servicePort}/health`, service, "external service");
  console.log(`[scenario] external service on :${servicePort} (fail-first + 2.5s hold)`);

  const orderId = `ORD-${Date.now()}`;
  const instanceId = `charge-${Date.now()}`;
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const cliArgs = (port) => [
    join(pkgDir, "host/cli.mjs"),
    "dev",
    "--config", consumerConfig,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--storage", consumerStorage,
    "--build-dir", join(temp, "bundles"),
  ];

  let port = await freePort();
  dev = startProcess(cliArgs(port), "consumer dev #1");
  await waitUrl(`http://127.0.0.1:${port}/health`, dev, "consumer dev #1");

  const create = await fetch(`http://127.0.0.1:${port}/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: instanceId, params: { orderId, serviceUrl } }),
  });
  assert(create.ok, `create failed: HTTP ${create.status} ${await create.text()}`);
  console.log("[scenario] instance created; waiting for retry + applied side effect");

  // call 1 = 503 (retry fires), call 2 = applied and holding its response.
  // Kill inside the hold: the downstream effect exists, the runtime never saw
  // the response, the step result was never persisted.
  let stats = await waitCalls(servicePort, "charge", 2);
  assert(stats.applied.charge[orderId], "charge was not applied before the kill");
  await stop(dev, "SIGKILL");
  evidence.killPoints.push({
    at: "post-side-effect-before-commit",
    observedCalls: stats.calls.charge,
    appliedKeys: Object.keys(stats.applied.charge),
  });
  console.log("[scenario] SIGKILL #1: downstream effect applied, step result uncommitted");

  port = await freePort();
  dev = startProcess(cliArgs(port), "consumer dev #2");
  await waitUrl(`http://127.0.0.1:${port}/health`, dev, "consumer dev #2");

  // The re-executed step hits the service again; the idempotency key dedups
  // it and the workflow proceeds to waitForEvent.
  stats = await waitCalls(servicePort, "charge", 3);
  const waiting = await waitStatus(port, instanceId, ["waiting", "running"]);
  assert(waiting.status === "waiting", `expected waiting on waitForEvent, got ${waiting.status}`);
  await stop(dev, "SIGKILL");
  evidence.killPoints.push({
    at: "waiting-for-event",
    observedCalls: stats.calls.charge,
    instanceStatus: waiting.status,
  });
  console.log("[scenario] SIGKILL #2: parked on waitForEvent");

  port = await freePort();
  dev = startProcess(cliArgs(port), "consumer dev #3");
  await waitUrl(`http://127.0.0.1:${port}/health`, dev, "consumer dev #3");
  await waitStatus(port, instanceId, "waiting");

  const sent = await fetch(
    `http://127.0.0.1:${port}/event?id=${encodeURIComponent(instanceId)}&type=approved`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    },
  );
  assert(sent.ok, `sendEvent failed: HTTP ${sent.status}`);

  const final = await waitStatus(port, instanceId, ["complete", "errored", "terminated"]);
  assert(final.status === "complete", `instance ended as ${final.status}`);

  stats = await serviceStats(servicePort);
  evidence.finishedAt = new Date().toISOString();
  evidence.finalStatus = final.status;
  evidence.finalSteps = final.steps ?? null;
  evidence.output = final.output ?? null;
  evidence.service = stats;
  evidence.observations = {
    chargeCalls: stats.calls.charge,
    chargeAppliedRecords: Object.keys(stats.applied.charge).length,
    chargeReplayDeduplicated: stats.calls.charge === 3
      && Object.keys(stats.applied.charge).length === 1,
    finalizeCalls: stats.calls.finalize,
    finalizeAppliedRecords: Object.keys(stats.applied.finalize).length,
  };

  // Evidence is written BEFORE assertions so a mid-run failure still leaves
  // the full diagnostic trail (kill points, call ledger, final state).
  writeFileSync(
    join(resultsDir, "scenario-consumer.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );

  assert(stats.calls.charge === 3,
    `expected 3 charge calls (503, apply, replay dedup), got ${stats.calls.charge}`);
  assert(Object.keys(stats.applied.charge).length === 1,
    "charge must produce exactly one applied record despite the replay");
  assert(stats.applied.charge[orderId]?.key === orderId,
    "applied record must be keyed by the business orderId");
  // finalize is also fail-first: 503 then apply — the retry policy fires
  // there too, still one applied record.
  assert(stats.calls.finalize === 2,
    `expected 2 finalize calls (503, apply), got ${stats.calls.finalize}`);
  assert(Object.keys(stats.applied.finalize).length === 1,
    "finalize must produce exactly one applied record");
  assert(final.output?.charge?.key === orderId, "workflow output lost the charge record");

  console.log("[scenario] evidence -> compat-results/scenario-consumer.json");
  console.log("[scenario] replay deduplicated by business key: 3 calls, 1 applied record");
  console.log("consumer-scenario: PASS");
} finally {
  await stop(dev);
  await stop(service);
  rmSync(temp, { recursive: true, force: true });
}
