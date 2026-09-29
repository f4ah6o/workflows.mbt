// Hosted Cloudflare canary oracle (credential-gated).
//
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node compat/canary.mjs
//
// Deploys the probe worker to a disposable hosted Worker, runs the
// differential probe catalog over HTTP, diffs normalized traces against a
// live workflows.mbt run of the same catalog, then deletes the deployment.
// Results land in compat-results/differential-hosted.json so the capability
// matrix can carry hosted_differential evidence.
//
// Without both credentials it exits 0 after printing the deferral notice —
// see docs/hosted-canary.md. The canary never runs in normal PR CI.

import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectTraces, diffRun } from "./probe-client.mjs";
import { buildResultFingerprint, computeRelevantInputs } from "./coverage-model.mjs";

const execFileP = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
mkdirSync(resultsDir, { recursive: true });

if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
  console.log("hosted canary deferred — CF_API_TOKEN/CF_ACCOUNT_ID not set (see docs/hosted-canary.md)");
  process.exit(0);
}

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const probes = catalog.probes
  .filter((entry) => entry.differential !== false)
  .map((entry) => entry.id);
const fixture = join(root, "compat/probes/wrangler.jsonc");
const canaryName = "workflows-mbt-canary";
const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-canary-"));

const wrangler = process.platform === "win32"
  ? join(root, "node_modules/.bin/wrangler.cmd")
  : join(root, "node_modules/.bin/wrangler");

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

async function collectLocal() {
  const port = await freePort();
  const detached = process.platform !== "win32";
  const child = spawn(process.execPath, [
    "host/cli.mjs", "dev",
    "--config", fixture,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--storage", join(temp, "canary.sqlite"),
    "--build-dir", join(temp, "bundles"),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true" }, detached });
  try {
    const deadline = Date.now() + 45000;
    let ready = false;
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });
    while (Date.now() < deadline) {
      if (child.exitCode != null) break;
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/health");
        if (response.ok) { ready = true; break; }
      } catch {}
      await delay(100);
    }
    if (!ready) {
      const detail = child.exitCode != null
        ? `exited with code ${child.exitCode}`
        : "did not become ready within 45s";
      throw new Error(`local workflows.mbt runtime ${detail}\n${stderrTail}`.trim());
    }
    return await collectTraces("http://127.0.0.1:" + port, "workflows-mbt", probes, { log: (m) => console.error(m) });
  } catch (error) {
    return { traces: {}, probeErrors: {}, error: error?.message ?? String(error) };
  } finally {
    if (detached && child.pid != null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    child.kill?.("SIGTERM");
  }
}

async function waitDeployed(url) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url + "/health");
      if (response.ok) return;
    } catch {}
    await delay(2000);
  }
  throw new Error("canary deployment did not come up at " + url);
}

// The canary URL must point at the actual deployment — `workers.dev` alone is
// not a valid hostname. Resolution order: explicit CF_CANARY_URL, the URL
// wrangler prints on deploy, then CF_ACCOUNT_SUBDOMAIN to construct
// <name>.<subdomain>.workers.dev. Without any of them we fail fast instead of
// polling a URL that can never answer.
function resolveCanaryUrl(deployOutput) {
  if (process.env.CF_CANARY_URL) return process.env.CF_CANARY_URL;
  const printed = deployOutput.match(/https:\/\/[^\s"'`]+workers\.dev[^\s"'`]*/)?.[0];
  if (printed) return printed;
  if (process.env.CF_ACCOUNT_SUBDOMAIN) {
    return `https://${canaryName}.${process.env.CF_ACCOUNT_SUBDOMAIN}.workers.dev`;
  }
  throw new Error(
    "canary URL not derivable: set CF_CANARY_URL, or CF_ACCOUNT_SUBDOMAIN " +
    "(the account's workers.dev subdomain), or run a wrangler version that " +
    "prints the deployed URL",
  );
}

let deployed = false;
try {
  // Deploy the same probe worker source to a disposable hosted target.
  const { stdout, stderr } = await execFileP(wrangler, [
    "deploy",
    "--config", fixture,
    "--name", canaryName,
    "--compatibility-date", "2026-09-26",
  ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  deployed = true;
  const canaryUrl = resolveCanaryUrl(String(stdout) + "\n" + String(stderr));
  console.log("canary deployed at " + canaryUrl);

  // A hosted side that never comes up, or probes that fail over HTTP, are
  // drift evidence — record them into the result file rather than aborting
  // before one is written.
  let hostedSide;
  try {
    await waitDeployed(canaryUrl);
    hostedSide = await collectTraces(canaryUrl, "hosted", probes, { log: (m) => console.error(m) });
  } catch (error) {
    hostedSide = { traces: {}, probeErrors: {}, error: error?.message ?? String(error) };
  }
  const local = await collectLocal();

  const { differences, probeErrors, pass } = diffRun(hostedSide, local, probes, { upstreamName: "hosted" });
  let wranglerVersion = null;
  try {
    wranglerVersion = (await execFileP(wrangler, ["--version"], { cwd: root })).stdout.trim().replace(/^.*\s/, "");
  } catch {}
  const runId = process.env.WORKFLOWS_MBT_RUN_ID ?? "hosted-" + Date.now();
  // Hosted evidence is an observation against Cloudflare production (issue
  // §7): there is no binary candidate, so the fingerprint records the repo
  // side's relevant inputs plus the canary's deployed compatibility_date.
  const fingerprint = buildResultFingerprint({
    runId,
    oracle: "hosted",
    candidate: null,
    relevantInputs: computeRelevantInputs(root, {
      conditions: { probesCompatibilityDate: "2026-09-26", compatibilityFlags: [] },
    }),
    commit: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
  });
  const result = {
    oracle: "hosted",
    runId,
    checkedAt: new Date().toISOString(),
    versions: { wrangler: wranglerVersion },
    fingerprint,
    probes,
    hosted: hostedSide.traces,
    workflowsMbt: local.traces,
    differences,
    probeErrors,
    sideErrors: {
      hosted: hostedSide.error ?? null,
      workflowsMbt: local.error ?? null,
    },
    pass,
  };
  writeFileSync(join(resultsDir, "differential-hosted.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({
    oracle: "hosted",
    pass: result.pass,
    differences: Object.keys(differences),
    probeErrors: Object.keys(probeErrors),
    sideErrors: result.sideErrors,
  }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  if (deployed) {
    // Cleanup is attempted on success and failure alike.
    try {
      await execFileP(wrangler, ["delete", "--name", canaryName, "--force"], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      console.error("canary cleanup failed (delete " + canaryName + " manually): " + (error?.message ?? error));
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
