import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fc from "fast-check";
import { WorkflowRuntime } from "../host/engine.mjs";
import { observeDuplicate, observeMissing } from "../fixtures/binding-errors/observe.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, "fixtures/binding-errors/wrangler.jsonc");
const backend = process.env.WORKFLOWS_BINDING_BACKEND ?? "local";
if (!["local", "cloudflare"].includes(backend)) throw new Error("Invalid WORKFLOWS_BINDING_BACKEND");

// A portable subset of valid public IDs, including the 100-character boundary.
// Arrays shrink both length and characters; the smallest ID is "a".
const idArbitrary = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
  minLength: 1, maxLength: 100,
}).map((characters) => characters.join(""));
const parameters = {
  seed: Number(process.env.FC_SEED ?? 20261005),
  numRuns: Number(process.env.FC_RUNS ?? 100),
  verbose: true,
  ...(process.env.FC_PATH == null ? {} : { path: process.env.FC_PATH }),
};

async function makeBackend(t) {
  const temp = mkdtempSync(join(tmpdir(), "workflows-binding-pbt-"));
  if (backend === "local") {
    const runtime = await WorkflowRuntime.open({
      configPath, storagePath: join(temp, "runtime.sqlite"), buildDir: join(temp, "bundles"),
    });
    t.after(async () => {
      try { await runtime.close(); }
      finally { rmSync(temp, { recursive: true, force: true }); }
    });
    const binding = runtime.env().WORKFLOW;
    return {
      missing: (id) => observeMissing(binding, id),
      duplicate: (id, contenders) => observeDuplicate(binding, id, contenders),
      cleanup: (id) => binding.deleteBatch([id]),
    };
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(process.execPath, [
    join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local",
    "--config", configPath, "--ip", "127.0.0.1", "--port", String(port),
    "--persist-to", join(temp, "state"),
  ], {
    cwd: temp, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: temp, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  t.after(async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const signal = (kind) => {
      try { process.kill(-child.pid, kind); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    if (child.pid != null) {
      signal("SIGTERM");
      await Promise.race([exited, delay(1500)]);
      signal("SIGKILL");
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode != null) throw new Error(output);
    try {
      if ((await fetch(url + "/health", { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "Cloudflare local failed to start:\n" + output);
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Oracle HTTP ${response.status}: ${(await response.text()).slice(-2000)}`);
    return await response.json();
  };
  return {
    missing: (id) => post("/missing", { id }),
    duplicate: (id, contenders) => post("/duplicate", { id, contenders }),
    cleanup: (id) => post("/cleanup", { id }),
  };
}

test("binding PBT: missing instance exposes the Cloudflare error marker", async (t) => {
  const api = await makeBackend(t);
  await fc.assert(fc.asyncProperty(idArbitrary, async (id) => {
    const observed = await api.missing(id);
    assert.equal(observed.rejected, true);
    assert.ok(observed.error.message.includes("instance.not_found"), JSON.stringify(observed));
  }), parameters);
});

test("binding PBT: duplicate creates expose the Cloudflare error prefix", async (t) => {
  const api = await makeBackend(t);
  await fc.assert(fc.asyncProperty(idArbitrary, fc.integer({ min: 2, max: 8 }), async (id, contenders) => {
    try {
      const observed = await api.duplicate(id, contenders);
      assert.equal(observed.successes, 1);
      assert.equal(observed.winnerId, id);
      assert.equal(observed.errors.length, contenders - 1);
      for (const error of observed.errors) {
        assert.ok(error.message.startsWith("(instance.already_exists)"), JSON.stringify(error));
      }
    } finally {
      await api.cleanup(id);
    }
  }), parameters);
});
