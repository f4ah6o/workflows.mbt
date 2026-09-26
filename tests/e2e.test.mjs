import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import test from "node:test";
import { WorkflowRuntime } from "../host/engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basicConfig = join(root, "fixtures/cloudflare-basic/wrangler.jsonc");
const e2eConfig = join(root, "fixtures/e2e/wrangler.jsonc");
const cli = join(root, "host/cli.mjs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { timeout = 5000, every = 20 } = {}) {
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

function tempRuntimePaths(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    storagePath: join(dir, "workflows.db"),
    buildDir: join(dir, "bundles"),
  };
}

async function openRuntime(configPath, paths, env = {}) {
  return await WorkflowRuntime.open({
    configPath,
    storagePath: paths.storagePath,
    buildDir: paths.buildDir,
    env,
  });
}

async function drain(runtime, id, timeout = 5000) {
  return await poll(async () => {
    await runtime.runPending();
    const status = runtime.instanceStatus(id);
    if (["complete", "errored", "terminated"].includes(status.status)) return status;
    return null;
  }, { timeout, every: 10 });
}

async function startCounterServer() {
  const counts = new Map();
  const server = createServer((req, res) => {
    const key = req.url ?? "/";
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === "/retry" && counts.get(key) < 3) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, key }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    counts,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function spawnDev(configPath, paths) {
  return spawn(
    process.execPath,
    [
      cli,
      "dev",
      "--config",
      configPath,
      "--storage",
      paths.storagePath,
      "--build-dir",
      paths.buildDir,
      "--poll-ms",
      "10",
    ],
    { cwd: root, stdio: "ignore" },
  );
}

async function stopChild(child, signal = "SIGTERM") {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit");
  const sent = child.kill(signal);
  if (!sent && (child.exitCode != null || child.signalCode != null)) return;
  await exited;
}

function dbSnapshot(path, query, ...args) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(query).all(...args);
  } finally {
    db.close();
  }
}

test("CLOUDFLARE_SOURCE_UNMODIFIED_OK", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-basic-");
  const source = join(root, "fixtures/cloudflare-basic/src/index.ts");
  const before = createHash("sha256").update(readFileSync(source)).digest("hex");

  const runtime = await openRuntime(basicConfig, paths);
  t.after(() => runtime.close());
  const instance = await runtime.trigger(
    "my-workflow",
    { id: "basic-1", params: { name: "Alice", url: `${counter.baseUrl}/data` } },
  );
  const status = await drain(runtime, instance.id);
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output, {
    name: "Alice",
    data: { ok: true, key: "/data" },
  });

  const after = createHash("sha256").update(readFileSync(source)).digest("hex");
  assert.equal(after, before);
});

test("durable replay and durable sleep survive SIGKILL without rerunning A/B", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-crash-");

  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger(
    "durable",
    {
      id: "crash-1",
      params: { baseUrl: counter.baseUrl, sleepMs: 600 },
    },
    { run: false },
  );
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT name, state FROM steps WHERE instance_id=? ORDER BY ordinal",
      instance.id,
    );
    return rows.some((r) => r.name === "pause" && r.state === "waiting") ? rows : null;
  });

  const timer = dbSnapshot(
    paths.storagePath,
    "SELECT wake_at FROM timers WHERE instance_id=? AND kind='sleep'",
    instance.id,
  )[0];
  assert.ok(timer?.wake_at);
  await stopChild(first, "SIGKILL");

  await wait(300);
  const restartAt = Date.now();
  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second));

  const completed = await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT status, output, updated_at FROM instances WHERE id=?",
      instance.id,
    );
    return rows[0]?.status === "complete" ? rows[0] : null;
  }, { timeout: 5000 });

  assert.equal(counter.counts.get("/A"), 1);
  assert.equal(counter.counts.get("/B"), 1);
  assert.equal(counter.counts.get("/C"), 1);
  assert.ok(
    completed.updated_at - restartAt < 520,
    "sleep deadline should not restart from zero after process restart",
  );
  assert.ok(completed.updated_at >= timer.wake_at);
});

test("retry attempts and retry timer survive runtime process restart", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-retry-");
  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger(
    "retry",
    { id: "retry-1", params: { baseUrl: counter.baseUrl } },
    { run: false },
  );
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  await poll(() => {
    const attempts = dbSnapshot(
      paths.storagePath,
      "SELECT attempt, state FROM attempts WHERE instance_id=? ORDER BY attempt",
      instance.id,
    );
    const timers = dbSnapshot(
      paths.storagePath,
      "SELECT wake_at FROM timers WHERE instance_id=? AND kind='retry'",
      instance.id,
    );
    return attempts.length === 1 && timers.length === 1 ? { attempts, timers } : null;
  });
  await stopChild(first, "SIGKILL");

  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second));
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT status FROM instances WHERE id=?",
      instance.id,
    );
    return rows[0]?.status === "complete";
  }, { timeout: 5000 });

  const attempts = dbSnapshot(
    paths.storagePath,
    `SELECT attempt, state FROM attempts
     WHERE instance_id=? AND step_name='retry-me' ORDER BY attempt`,
    instance.id,
  );
  assert.deepEqual(attempts, [
    { attempt: 1, state: "failed" },
    { attempt: 2, state: "failed" },
    { attempt: 3, state: "completed" },
  ]);
  assert.equal(counter.counts.get("/retry"), 3);
});

test("waitForEvent survives restart and consumes pre-buffered events", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-events-");
  let runtime = await openRuntime(e2eConfig, paths);
  const waiting = await runtime.trigger("approval", { id: "approval-1", params: {} });
  assert.equal(runtime.instanceStatus(waiting.id).status, "waiting");
  runtime.close();

  runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());
  await runtime.sendEvent(waiting.id, {
    type: "approved",
    payload: { approved: true },
  });
  const status = await drain(runtime, waiting.id);
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output, { approved: true });

  const pre = await runtime.trigger(
    "approval",
    { id: "approval-pre", params: {} },
    { run: false },
  );
  await runtime.sendEvent(pre.id, {
    type: "approved",
    payload: { approved: "early" },
  });
  const preStatus = await drain(runtime, pre.id);
  assert.equal(preStatus.status, "complete");
  assert.deepEqual(preStatus.output, { approved: "early" });
});

test("duplicate step names use stable 1-origin count and output is queryable", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-count-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());
  const instance = await runtime.trigger("duplicate", { id: "dupe-1", params: {} });
  const status = await drain(runtime, instance.id);
  assert.deepEqual(status.output, [
    { i: 0, count: 1 },
    { i: 1, count: 2 },
    { i: 2, count: 3 },
  ]);
  assert.deepEqual(
    runtime.storage.listSteps(instance.id).map((step) => ({
      type: step.type,
      name: step.name,
      count: step.count,
    })),
    [
      { type: "do", name: "process", count: 1 },
      { type: "do", name: "process", count: 2 },
      { type: "do", name: "process", count: 3 },
    ],
  );
});

test("restart from a step reuses earlier output and reruns target onward", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-restart-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("durable", {
    id: "restart-1",
    params: { baseUrl: counter.baseUrl, sleepMs: 20 },
  });
  await drain(runtime, instance.id);
  assert.deepEqual(
    [counter.counts.get("/A"), counter.counts.get("/B"), counter.counts.get("/C")],
    [1, 1, 1],
  );

  await instance.restart({ from: { name: "B", count: 1, type: "do" } });
  await drain(runtime, instance.id);
  assert.deepEqual(
    [counter.counts.get("/A"), counter.counts.get("/B"), counter.counts.get("/C")],
    [1, 2, 2],
  );
});
