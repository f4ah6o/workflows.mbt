// Source-unmodified fallback drill.
//
//   node compat/run-drill.mjs [--oracle pinned|latest] [--skip-cloudflare]
//
// Runs fixtures/drill unmodified under the Cloudflare oracle (cf dev)
// and under the workflows.mbt dev server, SIGKILLs the local runtime while
// the workflow is suspended in step.sleep, restarts it from persisted state,
// and requires both sides to produce identical terminal output.
//
// The drill record lands in compat-results/drill-<timestamp>.json with the
// repository commit, artifact version, oracle versions, workflow source
// digest, per-side results, and known differences.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { candidateUsable, loadCandidate, resultsDirFor } from "./candidate.mjs";
import { buildResultFingerprint, computeRelevantInputs } from "./coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
mkdirSync(resultsDir, { recursive: true });

const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "pinned";
if (!["pinned", "latest"].includes(oracle)) throw new Error("oracle must be pinned or latest");
const skipCloudflare = process.argv.includes("--skip-cloudflare");
const candidateIndex = process.argv.indexOf("--candidate");
const candidateArg = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : null;
const resultsDirOverride = process.env.WORKFLOWS_MBT_RESULTS_DIR ? resolve(process.env.WORKFLOWS_MBT_RESULTS_DIR) : resultsDir;
const candidate = await loadCandidate(oracle, { candidatePath: candidateArg, resultsDir: resultsDirOverride });
if (!candidateUsable(candidate) && !skipCloudflare) {
  throw new Error("upstream candidate unusable: " + (candidate.error ?? "unknown") + " — not a drill result");
}

const fixture = join(root, "fixtures/drill/cloudflare.config.ts");
const sourceDigest = createHash("sha256")
  .update(readFileSync(join(root, "fixtures/drill/src/index.ts")))
  .digest("hex");
const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-drill-"));
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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

function start(command, args, label, cwd = root) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "true" },
    detached,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.drillOutput = () => output;
  child.drillDetached = detached;
  return child;
}

function signalTree(child, signal) {
  if (child.drillDetached && child.pid != null) {
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
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(label + " exited before ready\n" + child.drillOutput().slice(-4000));
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health");
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(label + " did not become ready\n" + child.drillOutput().slice(-4000));
}

async function createInstance(port, id) {
  const response = await fetch("http://127.0.0.1:" + port + "/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, params: { marker: "fallback-drill" } }),
  });
  if (!response.ok) throw new Error("create failed: HTTP " + response.status + " " + (await response.text()));
  return response.json();
}

async function status(port, id) {
  const response = await fetch("http://127.0.0.1:" + port + "/status?id=" + encodeURIComponent(id));
  if (!response.ok) throw new Error("status failed: HTTP " + response.status);
  return response.json();
}

async function waitStatus(port, id, wanted, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await status(port, id);
    if (Array.isArray(wanted) ? wanted.includes(last.status) : last.status === wanted) return last;
    await delay(150);
  }
  throw new Error("instance " + id + " did not reach " + JSON.stringify(wanted) + " (last " + JSON.stringify(last) + ")");
}

function cfCommand() {
  const bin = process.platform === "win32" && candidate.paths.cfBin.endsWith("/cf")
    ? candidate.paths.cfBin + ".cmd"
    : candidate.paths.cfBin;
  return { command: bin, args: [] };
}

const drillId = "drill-" + Date.now();
const storage = join(temp, "drill.sqlite");

async function runCloudflare() {
  const port = await freePort();
  const cf = cfCommand();
  const oracleDir = join(temp, "cf-drill");
  cpSync(join(root, "fixtures/drill"), oracleDir, { recursive: true });
  const packageRoot = candidate.installDir ?? root;
  cpSync(join(packageRoot, "package.json"), join(oracleDir, "package.json"));
  cpSync(join(packageRoot, "package-lock.json"), join(oracleDir, "package-lock.json"));
  symlinkSync(
    join(packageRoot, "node_modules"),
    join(oracleDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const child = start(cf.command, [
    ...cf.args,
    "dev",
    "--port", String(port),
    "--host", "127.0.0.1",
  ], "cloudflare/" + oracle, oracleDir);
  try {
    await waitReady(port, child, "cloudflare/" + oracle);
    await createInstance(port, drillId);
    const final = await waitStatus(port, drillId, ["complete", "errored", "terminated"], 45000);
    return { status: final.status, output: final.output ?? null };
  } finally {
    await stop(child);
  }
}

async function runFallback() {
  const port = await freePort();
  const args = (p) => [
    "host/cli.mjs", "dev",
    "--config", fixture,
    "--host", "127.0.0.1",
    "--port", String(p),
    "--storage", storage,
    "--build-dir", join(temp, "bundles"),
  ];
  let child = start(process.execPath, args(port), "workflows.mbt");
  await waitReady(port, child, "workflows.mbt");
  await createInstance(port, drillId);
  // Crash mid-suspension: wait until the instance is parked in step.sleep.
  await waitStatus(port, drillId, "waiting", 20000);
  await stop(child, "SIGKILL");
  const restartedPort = await freePort();
  child = start(process.execPath, args(restartedPort), "workflows.mbt");
  try {
    await waitReady(restartedPort, child, "workflows.mbt(restarted)");
    const final = await waitStatus(restartedPort, drillId, ["complete", "errored", "terminated"], 45000);
    return { status: final.status, output: final.output ?? null, restartedFromPersistedState: true };
  } finally {
    await stop(child);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

try {
  const cloudflare = skipCloudflare ? null : await runCloudflare();
  const fallback = await runFallback();
  const sameOutput = !cloudflare || deepEqual(cloudflare.output, fallback.output);
  const record = {
    checkedAt: new Date().toISOString(),
    commit: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        // Not a git checkout (e.g. running from an extracted release artifact).
        return null;
      }
    })(),
    artifactVersion: pkg.version,
    oracle: {
      mode: oracle,
      candidateId: candidate.id,
      cf: candidate.versions?.cf ?? null,
      vitePlugin: candidate.versions?.vitePlugin ?? null,
      wranglerLegacySchema: candidate.versions?.wrangler ?? null,
      workersTypes: candidate.versions?.workersTypes ?? null,
      workerd: candidate.versions?.workerd ?? null,
      runtime: candidate.runtime ?? null,
      compatibilityDate: manifest.compatibilityDate,
      skipped: skipCloudflare,
    },
    sourceDigest: "sha256:" + sourceDigest,
    cloudflare,
    fallback,
    outputsMatch: sameOutput,
    knownDifferences: [],
    pass: fallback.status === "complete" && sameOutput,
    // Run-result fingerprint (issue §7) — relevant-input hashes + candidate
    // identity so later readers can judge this drill evidence fresh or STALE.
    fingerprint: buildResultFingerprint({
      runId: process.env.WORKFLOWS_MBT_RUN_ID ?? "drill-" + oracle + "-" + Date.now(),
      oracle,
      candidate,
      relevantInputs: computeRelevantInputs(root, candidate),
      commit: record.commit,
    }),
  };
  const name = "drill-" + record.checkedAt.replaceAll(":", "-").replace(/\..*/, "") + ".json";
  writeFileSync(join(resultsDir, name), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(resultsDir, "drill-latest.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
  if (!record.pass) process.exit(1);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
