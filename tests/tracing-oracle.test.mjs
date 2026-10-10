import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WorkerExecutionContext } from "../host/execution-context.mjs";
import { observeTracingScope } from "./fixtures/tracing-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// CI exercises the pinned oracle by default. An isolated candidate can run
// precisely the same test without changing node_modules or the package lock.
const candidatePath = process.env.WORKFLOWS_MBT_TRACING_CANDIDATE;
const candidate = candidatePath ? JSON.parse(readFileSync(candidatePath, "utf8")) : null;
const packageRoot = candidate?.installDir ?? root;
const pluginVersion = JSON.parse(readFileSync(join(packageRoot, "node_modules/@cloudflare/vite-plugin/package.json"), "utf8")).version;
const verifiedScopes = { "1.62.0": "callback", "1.62.4": "invocation", "1.62.5": "invocation", "1.63.1": "invocation" };

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

test(`real cf Workflow tracing scope matches local policy for Vite plugin ${pluginVersion}`, { timeout: 120_000 }, async (t) => {
  const scope = verifiedScopes[pluginVersion];
  assert.ok(scope, `Classify the tracing policy for unverified Vite plugin ${pluginVersion} before adding it here`);
  const temp = mkdtempSync(join(tmpdir(), "workflows-tracing-oracle-"));
  let child;
  t.after(() => {
    if (child?.pid != null) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }
    rmSync(temp, { recursive: true, force: true });
  });
  cpSync(join(root, "compat/probes"), temp, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) cpSync(join(packageRoot, file), join(temp, file));
  symlinkSync(join(packageRoot, "node_modules"), join(temp, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const sourcePath = join(temp, "src/index.ts");
  const source = readFileSync(sourcePath, "utf8");
  const start = source.indexOf('      case "entrypoint-ctx": {');
  const end = source.indexOf('      case "rollback": {', start);
  assert.ok(start >= 0 && end > start, "The entrypoint-ctx fixture must still exist");
  writeFileSync(sourcePath, `${observeTracingScope.toString()}\n${source.slice(0, start)}      case "entrypoint-ctx": return observeTracingScope(this.ctx.tracing);\n${source.slice(end)}`);
  const configDir = join(temp, "config");
  mkdirSync(configDir);
  const port = await freePort();
  child = spawn(join(packageRoot, "node_modules/.bin/cf"), ["dev"], {
    cwd: temp,
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "true", XDG_CONFIG_HOME: configDir, WORKFLOWS_MBT_ORACLE_HOST: "127.0.0.1", WORKFLOWS_MBT_ORACLE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `cf dev exited before readiness:\n${log}`);
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      if (ready) break;
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `cf dev did not become ready:\n${log}`);
  const response = await fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: "entrypoint-ctx", id: `tracing-scope-${Date.now()}` }),
    signal: AbortSignal.timeout(45_000),
  });
  const trace = await response.json();
  assert.equal(response.status, 200, JSON.stringify(trace));
  assert.equal(trace.status.status, "complete", JSON.stringify(trace));
  const local = new WorkerExecutionContext({ config: { tracingScope: scope } });
  const actual = await observeTracingScope(local.tracing);
  // Compare the complete, raw observation. In particular, preserve the
  // ambient-present boolean that originally exposed the versioned drift.
  assert.deepEqual(actual, trace.status.output);
  assert.equal(trace.status.output.ambientPresent, scope === "invocation");
  t.diagnostic(JSON.stringify({ candidateId: candidate?.id ?? "pinned-lockfile", pluginVersion, tracingScope: scope, upstream: trace.status.output }));
});
