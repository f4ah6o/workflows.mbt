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
import { collectTraces, diffRun } from "./probe-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "pinned";
if (!["pinned", "latest"].includes(oracle)) throw new Error("oracle must be pinned or latest");
const candidateIndex = process.argv.indexOf("--candidate");
const candidateArg = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : null;
const runId = process.env.WORKFLOWS_MBT_RUN_ID ?? "differential-" + oracle + "-" + Date.now();

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const catalog = JSON.parse(
  readFileSync(join(root, "compat/probes/catalog.json"), "utf8"),
);
const probeIndex = process.argv.indexOf("--probe");
const onlyProbe = probeIndex >= 0 ? process.argv[probeIndex + 1] : null;
// Probes with `differential: false` document behavior that cannot be diffed —
// e.g. upstream aborts the isolate on BigInt step output — so they are kept in
// the catalog (and capability matrix) but skipped by the differential runner.
const probes = onlyProbe
  ? [onlyProbe]
  : catalog.probes.filter((entry) => entry.differential !== false).map((entry) => entry.id);
if (onlyProbe && !catalog.probes.some((entry) => entry.id === onlyProbe)) {
  throw new Error("unknown probe: " + onlyProbe);
}
const fixture = join(root, "compat/probes/cloudflare.config.ts");
const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-diff-"));

// The upstream side runs the shared run candidate — for `latest` that is the
// isolated install resolved once at run entry, never a fresh `npx cf@latest`.
const candidate = await loadCandidate(oracle, { candidatePath: candidateArg, resultsDir });

// The run-result fingerprint (issue §7): relevant-input hashes + upstream
// candidate identity, so a later reader can decide whether this evidence is
// still fresh (STALE) instead of treating it as current. The git commit is
// provenance only — never a freshness key.
const fingerprint = () => buildResultFingerprint({
  runId,
  oracle,
  candidate,
  relevantInputs: computeRelevantInputs(root, candidate),
  commit: gitCommit(),
});

function cfCommand() {
  const bin = process.platform === "win32" && candidate.paths.cfBin.endsWith("/cf")
    ? candidate.paths.cfBin + ".cmd"
    : candidate.paths.cfBin;
  return { command: bin, args: [] };
}

if (!candidateUsable(candidate)) {
  const result = {
    oracle,
    runId,
    checkedAt: new Date().toISOString(),
    commit: gitCommit(),
    candidateId: candidate.id ?? null,
    phaseStatus: "upstream-acquisition-failure",
    error: candidate.error ?? "candidate not usable",
    probes: [],
    cloudflare: {},
    workflowsMbt: {},
    differences: {},
    probeErrors: {},
    sideErrors: { cloudflare: "acquisition-failure", workflowsMbt: null },
    pass: false,
    fingerprint: fingerprint(),
  };
  writeFileSync(join(resultsDir, "differential-" + oracle + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

function start(command, args, label, cwd = root) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd,
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

// A crashed or timed-out run can leave dev servers behind on a port; always
// bind a fresh free port so we never silently talk to a stale bundle.
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

async function collectWorkflowsMbt() {
  const port = await freePort();
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
    return await collectTraces(`http://127.0.0.1:${port}`, "workflows-mbt", probes, { log: (m) => console.error(m) });
  } catch (error) {
    // Runtime never came up or died — still produce a result file so the
    // drift record can act on it.
    return { traces: {}, probeErrors: {}, error: error?.message ?? String(error) };
  } finally {
    await stop(child);
  }
}

async function collectCloudflare() {
  const port = await freePort();
  const cf = cfCommand();
  const oracleDir = join(temp, "cf-oracle");
  cpSync(join(root, "compat/probes"), oracleDir, { recursive: true });
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
    return await collectTraces(`http://127.0.0.1:${port}`, "cloudflare", probes, { log: (m) => console.error(m) });
  } catch (error) {
    return { traces: {}, probeErrors: {}, error: error?.message ?? String(error) };
  } finally {
    await stop(child);
  }
}

try {
  const [cloudflare, workflowsMbt] = await Promise.all([collectCloudflare(), collectWorkflowsMbt()]);
  const { differences, probeErrors, pass } = diffRun(cloudflare, workflowsMbt, probes);
  const result = {
    oracle,
    runId,
    checkedAt: new Date().toISOString(),
    commit: gitCommit(),
    candidateId: candidate.id,
    versions: candidate.versions,
    runtime: candidate.runtime ?? null,
    probeSourceHash: "sha256:" + sha256File(join(root, "compat/probes/src/index.ts")),
    catalogHash: "sha256:" + sha256File(join(root, "compat/probes/catalog.json")),
    probes,
    cloudflare: cloudflare.traces,
    workflowsMbt: workflowsMbt.traces,
    differences,
    probeErrors,
    sideErrors: {
      cloudflare: cloudflare.error ?? null,
      workflowsMbt: workflowsMbt.error ?? null,
    },
    pass,
    fingerprint: fingerprint(),
  };
  writeFileSync(join(resultsDir, "differential-" + oracle + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({
    oracle,
    probes,
    pass: result.pass,
    differences: Object.keys(differences),
    probeErrors: Object.keys(probeErrors),
    sideErrors: result.sideErrors,
  }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
