// Shared storage-contract suite, run against every backend. SQLite runs
// unconditionally; PostgreSQL runs when WORKFLOWS_POSTGRES_URL points at a
// server (CI provides a postgres service container) and skips cleanly
// otherwise. Each PostgreSQL storage gets its own schema so concurrent runs
// never share tables; the schemas are dropped when the file finishes.
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "../host/config.mjs";
import { WorkflowRuntime } from "../host/engine.mjs";
import { loadKernel } from "../host/kernel.mjs";
import { PostgresStorage } from "../host/storage/postgres.mjs";
import { SQLiteStorage } from "../host/storage/sqlite.mjs";
import { storageContractTests } from "./storage-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eConfig = join(root, "fixtures/e2e/wrangler.jsonc");
const kernelPath = join(root, "dist/workflows_core.mjs");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, { timeout = 10_000, every = 20 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await wait(every);
  }
  throw new Error(`poll timeout; last=${String(last)}`);
}

// Engine-level proof for a backend: a durable workflow and a waitForEvent
// workflow driven to completion through the real kernel and storage.
function runtimeTests(label, makeStorage) {
  test(`${label}: runtime drives durable and event steps end to end`, async (t) => {
    if (!existsSync(kernelPath)) {
      t.skip("requires the built kernel (npm run build:core)");
      return;
    }
    const config = loadProjectConfig(e2eConfig, {
      buildDir: mkdtempSync(join(tmpdir(), "workflows-mbt-bundles-")),
    });
    const kernel = await loadKernel(kernelPath);
    const storage = makeStorage();
    t.after(() => storage.close());
    const runtime = new WorkflowRuntime({ config, kernel, storage, env: {} });
    await runtime.prepare();
    t.after(() => runtime.close());

    const instance = await runtime.trigger("duplicate", {
      id: `${label}-dup-${Date.now()}`,
      params: {},
    });
    const status = await poll(async () => {
      await runtime.runPending();
      const current = runtime.instanceStatus(instance.id);
      if (current.status === "complete") return current;
      return null;
    });
    assert.deepEqual(status.output, [
      { i: 0, count: 1 },
      { i: 1, count: 2 },
      { i: 2, count: 3 },
    ]);

    const waiting = await runtime.trigger("approval", {
      id: `${label}-approval-${Date.now()}`,
      params: {},
    });
    assert.equal(runtime.instanceStatus(waiting.id).status, "waiting");
    await runtime.sendEvent(waiting.id, {
      type: "approved",
      payload: { approved: true },
    });
    const finished = await poll(async () => {
      await runtime.runPending();
      const current = runtime.instanceStatus(waiting.id);
      if (current.status === "complete") return current;
      return null;
    });
    assert.deepEqual(finished.output, { approved: true });
  });
}

storageContractTests("sqlite", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workflows-mbt-sqlite-"));
  const storage = new SQLiteStorage(join(dir, "workflows.db"));
  t.after(() => storage.close());
  return storage;
});
runtimeTests("sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflows-mbt-sqlite-"));
  return new SQLiteStorage(join(dir, "workflows.db"));
});

const pgUrl = process.env.WORKFLOWS_POSTGRES_URL;
if (pgUrl == null) {
  test(
    "postgres storage contract + runtime",
    { skip: "WORKFLOWS_POSTGRES_URL is not set" },
    () => {},
  );
} else {
  const pg = (await import("pg")).default;
  const admin = new pg.Client(pgUrl);
  await admin.connect();
  const schemas = [];
  let seq = 0;
  const openPostgres = (t, schema = null) => {
    schema ??= `wf_test_${Date.now().toString(36)}_${(seq += 1)}`;
    schemas.push(schema);
    const storage = new PostgresStorage(pgUrl, { schema });
    t.after(() => storage.close());
    return storage;
  };
  after(async () => {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin.end();
  });

  storageContractTests("postgres", openPostgres);
  runtimeTests("postgres", () => openPostgres({ after() {} }));

  test("postgres: concurrent executors cannot claim one instance", async (t) => {
    // Two separate connections to the same schema race the same claim.
    const shared = `wf_test_${Date.now().toString(36)}_race`;
    const first = openPostgres(t, shared);
    const second = openPostgres(t, shared);
    const workflow = {
      name: "race-wf",
      binding: "WF",
      className: "Race",
      main: "src/index.ts",
    };
    first.registerWorkflow(workflow);
    const instance = first.createInstance({
      id: `race-${Date.now()}`,
      workflowName: workflow.name,
      payload: "{}",
    });
    // Two separate connections race the same claim; exactly one wins.
    assert.equal(first.claimInstance(instance.id, "exec-a", 60_000), true);
    assert.equal(second.claimInstance(instance.id, "exec-b", 60_000), false);

    // Scheduled firing claims are also single-winner across connections.
    const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
    const claim = { cron: "* * * * *", scheduledTime };
    const results = [
      first.claimScheduledInstance({
        id: `cf_a_${Date.now()}`, workflowName: workflow.name,
        payload: "{}", ...claim,
      }),
      second.claimScheduledInstance({
        id: `cf_b_${Date.now()}`, workflowName: workflow.name,
        payload: "{}", ...claim,
      }),
    ];
    assert.deepEqual(
      results.map((result) => result.created).sort(),
      [false, true],
    );
    assert.equal(
      first.listInstances(workflow.name).rows.filter(
        (row) => row.schedule_cron != null,
      ).length,
      1,
    );
  });
}
