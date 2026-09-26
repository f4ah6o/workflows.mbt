import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { diffTrace, normalizeTrace } from "./normalize.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
mkdirSync(resultsDir, { recursive: true });
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "pinned";
if (!["pinned", "latest"].includes(oracle)) throw new Error("oracle must be pinned or latest");

const probes = ["basic", "retry", "sleep", "wait-for-event", "rollback"];
const fixture = join(root, "compat/probes/wrangler.jsonc");
const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-diff-"));

function wranglerCommand() {
  if (oracle === "latest") {
    return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", "wrangler@latest"] };
  }
  return {
    command: process.platform === "win32" ? join(root, "node_modules/.bin/wrangler.cmd") : join(root, "node_modules/.bin/wrangler"),
    args: [],
  };
}

function start(command, args, label) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "true" },
    detached,
  });
  child.oracleDetached = detached;
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("exit", (code, signal) => {
    if (code && code !== 0) console.error(label + " exited: code=" + code + " signal=" + signal + "\n" + output.slice(-8000));
  });
  child.oracleOutput = () => output;
  return child;
}

function signalTree(child, signal) {
  if (!child) return;
  if (child.oracleDetached && child.pid != null) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode == null) child.kill(signal);
}

async function stop(child) {
  if (!child) return;
  signalTree(child, "SIGTERM");
  if (child.exitCode == null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
  }
  signalTree(child, "SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitReady(port, child, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(label + " exited before ready\n" + child.oracleOutput().slice(-8000));
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health");
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(label + " did not become ready\n" + child.oracleOutput().slice(-8000));
}

async function runProbe(port, runtime, probe) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        probe,
        id: "oracle-" + runtime + "-" + probe + "-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(runtime + "/" + probe + ": HTTP " + response.status + ": " + text);
    return normalizeTrace(JSON.parse(text));
  } finally {
    clearTimeout(timeout);
  }
}

async function collectWorkflowsMbt() {
  const port = 8790;
  const child = start(process.execPath, [
    "host/cli.mjs", "dev",
    "--config", fixture,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--storage", join(temp, "workflows-mbt.sqlite"),
    "--build-dir", join(temp, "bundles"),
  ], "workflows.mbt");
  try {
    await waitReady(port, child, "workflows.mbt");
    const traces = {};
    for (const probe of probes) traces[probe] = await runProbe(port, "workflows-mbt", probe);
    return traces;
  } finally {
    await stop(child);
  }
}

async function collectCloudflare() {
  const port = 8791;
  const wrangler = wranglerCommand();
  const child = start(wrangler.command, [
    ...wrangler.args,
    "dev",
    "--config", fixture,
    "--port", String(port),
    "--ip", "127.0.0.1",
    "--persist-to", join(temp, "wrangler"),
  ], "cloudflare/" + oracle);
  try {
    await waitReady(port, child, "cloudflare/" + oracle);
    const traces = {};
    for (const probe of probes) traces[probe] = await runProbe(port, "cloudflare", probe);
    return traces;
  } finally {
    await stop(child);
  }
}

try {
  const results = await Promise.all([collectCloudflare(), collectWorkflowsMbt()]);
  const cloudflare = results[0];
  const workflowsMbt = results[1];
  const differences = {};
  for (const probe of probes) {
    const diff = diffTrace(cloudflare[probe], workflowsMbt[probe]);
    if (diff) differences[probe] = diff;
  }
  const result = {
    oracle,
    checkedAt: new Date().toISOString(),
    probes,
    cloudflare,
    workflowsMbt,
    differences,
    pass: Object.keys(differences).length === 0,
  };
  writeFileSync(join(resultsDir, "differential-" + oracle + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ oracle, probes, pass: result.pass, differences: Object.keys(differences) }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
