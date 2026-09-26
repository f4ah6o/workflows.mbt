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
import { decodeDurableValue as decodeDurableValueForTest } from "../host/serialization.mjs";
import { handleWorkflowRest } from "../host/rest.mjs";
import { startWorkflowHttpServer } from "../host/server.mjs";

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
  const requests = [];
  const server = createServer((req, res) => {
    const key = req.url ?? "/";
    requests.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, key }));
      }, 120);
      return;
    }
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
    requests,
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
      "--no-http",
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
  t.after(() => stopChild(first, "SIGKILL"));
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
  t.after(() => stopChild(second, "SIGKILL"));

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
  t.after(() => stopChild(first, "SIGKILL"));
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


test("Promise.all keeps completed concurrent branches durable while another retries", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-parallel-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("parallel", {
    id: "parallel-1",
    params: { baseUrl: counter.baseUrl },
  });
  const status = await drain(runtime, instance.id);
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output, {
    retried: { branch: "retry", attempt: 3, count: 1 },
    stable: { branch: "stable", count: 2 },
  });
  assert.equal(counter.counts.get("/retry"), 3);
  assert.equal(counter.counts.get("/parallel-stable"), 1);
  assert.deepEqual(
    runtime.storage.listSteps(instance.id).map(({ name, count, state }) => ({
      name, count, state,
    })),
    [
      { name: "parallel", count: 1, state: "completed" },
      { name: "parallel", count: 2, state: "completed" },
    ],
  );
});

test("restart during Promise.all replays committed branches without rerunning callbacks", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-parallel-restart-");
  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger(
    "parallel-restart",
    {
      id: "parallel-restart-1",
      params: { baseUrl: counter.baseUrl, sleepMs: 600 },
    },
    { run: false },
  );
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(first, "SIGKILL"));
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT name, state FROM steps WHERE instance_id=? ORDER BY ordinal",
      instance.id,
    );
    const complete = rows.filter((row) =>
      row.name === "parallel-A" || row.name === "parallel-B"
    ).every((row) => row.state === "completed");
    const waiting = rows.some(
      (row) => row.name === "parallel-pause" && row.state === "waiting",
    );
    return rows.length === 3 && complete && waiting ? rows : null;
  });
  await stopChild(first, "SIGKILL");

  assert.equal(counter.counts.get("/parallel-A"), 1);
  assert.equal(counter.counts.get("/parallel-B"), 1);

  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second, "SIGKILL"));
  await poll(() => {
    const [row] = dbSnapshot(
      paths.storagePath,
      "SELECT status FROM instances WHERE id=?",
      instance.id,
    );
    return row?.status === "complete";
  }, { timeout: 5000 });

  assert.equal(counter.counts.get("/parallel-A"), 1);
  assert.equal(counter.counts.get("/parallel-B"), 1);
});

test("allSettled, any, and race accept concurrent durable step promises", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-combinators-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("promise-combinators", {
    id: "combinators-1",
    params: {},
  });
  const status = await drain(runtime, instance.id);
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output.settled, [
    { status: "fulfilled", value: "ok" },
    { status: "rejected", reason: "expected" },
  ]);
  assert.ok(["first", "second"].includes(status.output.any));
  assert.ok(["first", "second"].includes(status.output.race));
});


test("rollback runs in reverse order and resumes after SIGKILL without rerunning completed handlers", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-rollback-");

  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger("rollback", {
    id: "rollback-1",
    params: { baseUrl: counter.baseUrl },
  });
  assert.equal(runtime.instanceStatus(instance.id).status, "waiting");
  assert.deepEqual(
    runtime.storage.listRollbackRegistrations(instance.id).map(({ step_name, state }) => ({
      step_name, state,
    })),
    [
      { step_name: "rollback-second", state: "registered" },
      { step_name: "rollback-first", state: "registered" },
    ],
  );
  await instance.terminate({ rollback: true });
  assert.equal(runtime.requireInstance(instance.id).status, "rollingBack");
  assert.equal((await instance.status()).status, "running");
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(first, "SIGKILL"));
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      `SELECT step_name, state, attempt
       FROM rollback_registrations
       WHERE instance_id=?
       ORDER BY ordinal DESC`,
      instance.id,
    );
    return rows[0]?.step_name === "rollback-second" &&
      rows[0]?.state === "completed" &&
      rows[1]?.step_name === "rollback-first" &&
      rows[1]?.state === "waiting_retry"
      ? rows
      : null;
  });
  await stopChild(first, "SIGKILL");

  assert.equal(counter.counts.get("/rollback-B"), 1);
  assert.equal(counter.counts.get("/retry"), 1);
  assert.deepEqual(counter.requests.slice(0, 2), ["/rollback-B", "/retry"]);

  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second, "SIGKILL"));
  const terminal = await poll(() => {
    const [row] = dbSnapshot(
      paths.storagePath,
      "SELECT status, rollback_outcome, rollback_error FROM instances WHERE id=?",
      instance.id,
    );
    return row?.status === "terminated" ? row : null;
  }, { timeout: 5000 });
  await stopChild(second, "SIGTERM");

  assert.equal(terminal.rollback_outcome, "complete");
  assert.equal(terminal.rollback_error, null);
  assert.equal(counter.counts.get("/rollback-B"), 1);
  assert.equal(counter.counts.get("/retry"), 3);

  const verify = await openRuntime(e2eConfig, paths);
  t.after(() => verify.close());
  assert.deepEqual(verify.instanceStatus(instance.id).rollback, {
    outcome: "complete",
    error: undefined,
  });
});


test("scheduled workflow metadata is durable and scheduler restart is idempotent", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-schedule-");
  const minute = Math.floor(Date.now() / 60_000) * 60_000;

  let runtime = await openRuntime(e2eConfig, paths);
  assert.equal(await runtime.enqueueSchedules(minute), 1);
  await runtime.runPending();
  let rows = runtime.storage.listInstances("scheduled");
  assert.equal(rows.length, 1);
  let status = runtime.instanceStatus(rows[0].id);
  assert.equal(status.status, "complete");
  assert.ok(status.output.timestamp instanceof Date);
  assert.deepEqual(status.output.schedule, {
    cron: "* * * * *",
    scheduledTime: minute,
  });
  assert.ok(status.output.timestamp.getTime() >= minute);
  runtime.close();

  runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());
  assert.equal(await runtime.enqueueSchedules(minute), 0);
  assert.equal(runtime.storage.listInstances("scheduled").length, 1);

  assert.equal(await runtime.enqueueSchedules(minute + 2 * 60_000), 2);
  await runtime.runPending();
  rows = runtime.storage.listInstances("scheduled");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.scheduled_time).sort((a, b) => a - b),
    [minute, minute + 60_000, minute + 2 * 60_000],
  );
});


test("WorkflowInstance.subscribe replays history, filters, resumes, and streams live completion", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-subscribe-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const completed = await runtime.trigger("duplicate", {
    id: "subscribe-complete",
    params: {},
  });
  const history = await completed.subscribe({ filter: ["workflow_completed"] });
  const terminal = await history.next();
  assert.equal(terminal.done, false);
  assert.equal(terminal.value.type, "workflow_completed");
  assert.deepEqual(terminal.value.output, [
    { i: 0, count: 1 },
    { i: 1, count: 2 },
    { i: 2, count: 3 },
  ]);
  assert.equal((await history.next()).done, true);

  const terminalEventId = terminal.value.eventId;
  const resumed = await completed.subscribe({
    cursor: terminalEventId,
    filter: ["workflow_completed"],
  });
  assert.equal((await resumed.next()).done, true);

  const waiting = await runtime.trigger("approval", {
    id: "subscribe-live",
    params: {},
  });
  assert.equal(runtime.instanceStatus(waiting.id).status, "waiting");
  const live = await waiting.subscribe({
    filter: ["workflow_completed", "workflow_errored", "workflow_terminated"],
  });
  const next = live.next();
  await waiting.sendEvent({ type: "approved", payload: { approved: true } });
  await runtime.runPending();
  const liveTerminal = await next;
  assert.equal(liveTerminal.done, false);
  assert.equal(liveTerminal.value.type, "workflow_completed");
  assert.deepEqual(liveTerminal.value.output, { approved: true });
  assert.equal((await live.next()).done, true);
  live[Symbol.dispose]();
});


test("default Worker fetch handler can create a workflow binding instance unchanged", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-worker-fetch-");
  const runtime = await openRuntime(basicConfig, paths);
  t.after(() => runtime.close());

  const server = await startWorkflowHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "worker-fetch-1",
      name: "Worker",
      url: `${counter.baseUrl}/worker-data`,
    }),
  });
  assert.equal(response.status, 200);
  const initial = await response.json();
  assert.equal(initial.id, "worker-fetch-1");
  assert.equal(initial.workflowName, "my-workflow");
  assert.equal(initial.status, "queued");

  const status = await drain(runtime, "worker-fetch-1");
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output, {
    name: "Worker",
    data: { ok: true, key: "/worker-data" },
  });
});

test("REST compatibility facade uses the same lifecycle and event runtime", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-rest-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const request = (path, init = {}) =>
    handleWorkflowRest(
      runtime,
      new Request(`http://local.test${path}`, {
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        ...init,
      }),
    );

  let response = await request("/accounts/local/workflows/approval/instances", {
    method: "POST",
    body: JSON.stringify({
      instance_id: "rest-1",
      params: JSON.stringify({}),
    }),
  });
  assert.equal(response.status, 200);
  let createBody = await response.json();
  assert.equal(createBody.success, true);
  assert.deepEqual(createBody.errors, []);
  assert.deepEqual(createBody.messages, []);
  assert.equal(createBody.result.id, "rest-1");
  assert.equal(createBody.result.status, "queued");
  assert.equal(createBody.result.trigger_source, "api");

  await runtime.runPending();
  response = await request("/accounts/local/workflows/approval/instances/rest-1");
  assert.equal((await response.json()).result.status, "waiting");

  response = await request(
    "/accounts/local/workflows/approval/instances/rest-1/events/approved",
    {
      method: "POST",
      body: JSON.stringify({ payload: { approved: true } }),
    },
  );
  assert.equal(response.status, 200);
  const eventBody = await response.json();
  assert.equal(eventBody.success, true);
  assert.equal(eventBody.result.instanceId, "rest-1");
  assert.ok(Number.isFinite(Date.parse(eventBody.result.timestamp)));
  await runtime.runPending();

  response = await request("/accounts/local/workflows/approval/instances/rest-1");
  let body = await response.json();
  assert.equal(body.result.status, "complete");
  assert.deepEqual(body.result.output, { approved: true });

  response = await request(
    "/accounts/local/workflows/approval/instances/rest-1/status",
    {
      method: "PATCH",
      body: JSON.stringify({ status: "restart" }),
    },
  );
  assert.equal(response.status, 200);
  await runtime.runPending();
  assert.equal(runtime.instanceStatus("rest-1").status, "waiting");

  response = await request(
    "/accounts/local/workflows/approval/instances/rest-1/status",
    {
      method: "PATCH",
      body: JSON.stringify({ status: "terminate" }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(runtime.instanceStatus("rest-1").status, "terminated");

  response = await request("/accounts/local/workflows/approval/instances");
  body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.result.some((item) => item.id === "rest-1"), true);
  assert.equal(body.result_info.total_count, body.result.length);

  response = await request("/accounts/local/workflows/approval/instances/batch", {
    method: "POST",
    body: JSON.stringify([
      { instance_id: "rest-batch-a", params: "{}" },
      { instance_id: "rest-batch-a", params: "{}" },
      { instance_id: "rest-batch-b", params: "{}" },
    ]),
  });
  assert.equal(response.status, 200);
  const batchBody = await response.json();
  assert.equal(batchBody.success, true);
  assert.deepEqual(
    batchBody.result.map((item) => item.id),
    ["rest-batch-a", "rest-batch-b"],
  );

  response = await request("/accounts/local/workflows/approval/instances/rest-1", {
    method: "DELETE",
  });
  assert.equal(response.status, 204);
  response = await request("/accounts/local/workflows/approval/instances/rest-1");
  assert.equal(response.status, 404);
});


test("binding batch semantics repeat duplicate delete results and skip duplicate creates", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-batch-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());
  const binding = runtime.env().DUPLICATE;

  const created = await binding.createBatch([
    { id: "batch-a", params: {} },
    { id: "batch-a", params: {} },
    { id: "batch-b", params: {} },
  ]);
  assert.deepEqual(created.map((instance) => instance.id), ["batch-a", "batch-b"]);

  const result = await binding.deleteBatch(["batch-a", "batch-a", "missing"]);
  assert.deepEqual(result.deleted, [{ id: "batch-a" }, { id: "batch-a" }]);
  assert.deepEqual(result.errors, [
    { id: "missing", code: 404, message: "Workflow instance not found" },
  ]);
});

test("instance and default retention expire successful and errored state", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-retention-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const explicit = await runtime.trigger("duplicate", {
    id: "retention-explicit",
    params: {},
    retention: { successRetention: "30 milliseconds" },
  });
  assert.equal(runtime.instanceStatus(explicit.id).status, "complete");

  const retained = await runtime.trigger("retained", {
    id: "retention-default",
    params: {},
  });
  assert.equal(runtime.instanceStatus(retained.id).status, "complete");

  const errored = await runtime.trigger("error", {
    id: "retention-error",
    params: {},
    retention: { errorRetention: "35 milliseconds" },
  });
  assert.equal(runtime.instanceStatus(errored.id).status, "errored");

  await wait(75);
  assert.throws(() => runtime.instanceStatus("retention-explicit"), /not found/);
  assert.throws(() => runtime.instanceStatus("retention-default"), /not found/);
  assert.throws(() => runtime.instanceStatus("retention-error"), /not found/);
});

test("pause requested during a running step stops at the next durable boundary", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-pause-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger(
    "pause",
    { id: "pause-1", params: { baseUrl: counter.baseUrl } },
    { run: false },
  );
  const running = runtime.runInstance(instance.id);
  await poll(() => {
    const [attempt] = dbSnapshot(
      paths.storagePath,
      "SELECT state FROM attempts WHERE instance_id=? AND step_name='slow-boundary'",
      instance.id,
    );
    return attempt?.state === "running";
  });
  await instance.pause();
  assert.equal(runtime.requireInstance(instance.id).status, "waitingForPause");
  await running;
  assert.equal(runtime.instanceStatus(instance.id).status, "paused");
  assert.equal(counter.counts.get("/slow"), 1);
  assert.equal(counter.counts.get("/after-pause"), undefined);

  await instance.resume();
  await runtime.runPending();
  assert.equal(runtime.instanceStatus(instance.id).status, "complete");
  assert.equal(counter.counts.get("/slow"), 1);
  assert.equal(counter.counts.get("/after-pause"), 1);
});


test("workflow failure automatically rolls back completed and failed registered steps", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-auto-rollback-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("automatic-rollback", {
    id: "auto-rollback-1",
    params: { baseUrl: counter.baseUrl },
  });
  const status = await drain(runtime, instance.id);
  assert.equal(status.status, "errored");
  assert.equal(status.error.name, "Error");
  assert.equal(status.error.message, "automatic failure");
  assert.deepEqual(status.rollback, {
    outcome: "complete",
    error: undefined,
  });
  assert.deepEqual(
    counter.requests.filter((path) => path.startsWith("/auto-rollback-")),
    ["/auto-rollback-failing", "/auto-rollback-first"],
  );
  assert.deepEqual(
    runtime.storage.listRollbackRegistrations(instance.id).map(
      ({ step_name, state }) => ({ step_name, state }),
    ),
    [
      { step_name: "auto-failing", state: "completed" },
      { step_name: "auto-first", state: "completed" },
    ],
  );
});


async function collectSubscriptionEvents(instance, options = {}) {
  const subscription = await instance.subscribe(options);
  const events = [];
  try {
    while (true) {
      const result = await subscription.next();
      if (result.done) return events;
      events.push(result.value);
    }
  } finally {
    subscription[Symbol.dispose]();
  }
}

test("subscribe exposes step and retry attempt event shapes", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-subscribe-retry-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("retry", {
    id: "subscribe-retry",
    params: { baseUrl: counter.baseUrl },
  });
  await drain(runtime, instance.id);
  const events = await collectSubscriptionEvents(instance, {
    filter: [
      "step_started",
      "attempt_started",
      "attempt_completed",
      "attempt_errored",
      "step_completed",
      "workflow_completed",
    ],
  });
  assert.deepEqual(events.map((event) => event.type), [
    "step_started",
    "attempt_started",
    "attempt_errored",
    "attempt_started",
    "attempt_errored",
    "attempt_started",
    "attempt_completed",
    "step_completed",
    "workflow_completed",
  ]);
  assert.equal(events[0].stepName, "retry-me-1");
  assert.deepEqual(
    events.filter((event) => event.type === "attempt_started").map(
      ({ stepName, attempt }) => ({ stepName, attempt }),
    ),
    [
      { stepName: "retry-me-1", attempt: 1 },
      { stepName: "retry-me-1", attempt: 2 },
      { stepName: "retry-me-1", attempt: 3 },
    ],
  );
  for (const event of events.filter((event) => event.type === "attempt_errored")) {
    assert.equal(event.stepName, "retry-me-1");
    assert.equal(event.error.name, "Error");
    assert.ok(event.retryDelayMs >= 0 && event.retryDelayMs <= 80);
  }
  assert.equal(events.at(-2).type, "step_completed");
  assert.equal(events.at(-2).stepName, "retry-me-1");
  assert.deepEqual(events.at(-2).output, { attempt: 3 });
});

test("subscribe exposes normalized sleep and wait event metadata", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-subscribe-waits-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const sleeping = await runtime.trigger("durable", {
    id: "subscribe-sleep",
    params: { baseUrl: counter.baseUrl, sleepMs: 5 },
  });
  await drain(runtime, sleeping.id);
  const sleepEvents = await collectSubscriptionEvents(sleeping, {
    filter: ["sleep_started", "sleep_completed", "workflow_completed"],
  });
  assert.equal(sleepEvents[0].type, "sleep_started");
  assert.equal(sleepEvents[0].stepName, "pause-1");
  assert.equal(sleepEvents[0].durationMs, 5);
  assert.equal(sleepEvents[1].type, "sleep_completed");

  const waiting = await runtime.trigger("approval", {
    id: "subscribe-wait-metadata",
    params: {},
  });
  await waiting.sendEvent({ type: "approved", payload: { approved: true } });
  await runtime.runPending();
  const waitEvents = await collectSubscriptionEvents(waiting, {
    filter: ["wait_started", "wait_completed", "workflow_completed"],
  });
  assert.deepEqual(
    waitEvents.map(({ type, stepName, eventType }) => ({
      type, stepName, eventType,
    })),
    [
      { type: "wait_started", stepName: "approval-1", eventType: "approved" },
      { type: "wait_completed", stepName: "approval-1", eventType: undefined },
      { type: "workflow_completed", stepName: undefined, eventType: undefined },
    ],
  );
});

test("subscribe exposes rollback step and attempt lifecycle in reverse order", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-subscribe-rollback-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("automatic-rollback", {
    id: "subscribe-auto-rollback",
    params: { baseUrl: counter.baseUrl },
  });
  const events = await collectSubscriptionEvents(instance, {
    filter: [
      "rollback_started",
      "rollback_step_started",
      "rollback_attempt_started",
      "rollback_attempt_completed",
      "rollback_step_completed",
      "rollback_completed",
      "rollback_errored",
      "workflow_errored",
    ],
  });
  assert.deepEqual(events.map((event) => event.type), [
    "rollback_started",
    "rollback_step_started",
    "rollback_attempt_started",
    "rollback_attempt_completed",
    "rollback_step_completed",
    "rollback_step_started",
    "rollback_attempt_started",
    "rollback_attempt_completed",
    "rollback_step_completed",
    "rollback_completed",
    "workflow_errored",
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "rollback_step_started").map(
      (event) => event.stepName,
    ),
    ["auto-failing-1", "auto-first-1"],
  );
  assert.equal(events.at(-1).error.message, "automatic failure");
});


test("instance ids are scoped to each workflow binding", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-id-scope-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const duplicate = await runtime.env().DUPLICATE.create({
    id: "shared-id",
    params: {},
  });
  const error = await runtime.env().ERROR.create({
    id: "shared-id",
    params: {},
  });

  assert.equal(duplicate.id, "shared-id");
  assert.equal(error.id, "shared-id");
  assert.equal((await duplicate.status()).workflowName, "duplicate");
  assert.equal((await error.status()).workflowName, "error");

  const duplicateRow = runtime.storage.getInstanceByPublic("duplicate", "shared-id");
  const errorRow = runtime.storage.getInstanceByPublic("error", "shared-id");
  assert.ok(duplicateRow);
  assert.ok(errorRow);
  assert.notEqual(duplicateRow.id, errorRow.id);

  assert.throws(
    () => runtime.instanceStatus("shared-id"),
    /ambiguous across workflows/,
  );

  await duplicate.delete();
  assert.equal((await error.status()).workflowName, "error");
  assert.equal(runtime.storage.getInstanceByPublic("duplicate", "shared-id"), null);
});


test("structured non-JSON step values preserve types across SIGKILL replay", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-structured-restart-");
  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger(
    "structured-replay",
    {
      id: "structured-restart-1",
      params: { baseUrl: counter.baseUrl, sleepMs: 500 },
    },
    { run: false },
  );
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(first, "SIGKILL"));
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT name, state FROM steps WHERE instance_id=? ORDER BY ordinal",
      instance.id,
    );
    return rows.some(
      (row) => row.name === "structured-pause" && row.state === "waiting",
    ) ? rows : null;
  });
  await stopChild(first, "SIGKILL");
  assert.equal(counter.counts.get("/structured"), 1);

  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second, "SIGKILL"));
  await poll(() => {
    const [row] = dbSnapshot(
      paths.storagePath,
      "SELECT status FROM instances WHERE public_id=? AND workflow_name='structured-replay'",
      instance.id,
    );
    return row?.status === "complete";
  }, { timeout: 5000 });
  await stopChild(second, "SIGTERM");

  const verify = await openRuntime(e2eConfig, paths);
  t.after(() => verify.close());
  const status = verify.instanceStatus(instance.id, "structured-replay");
  assert.equal(counter.counts.get("/structured"), 1);
  assert.equal(status.output.dateIsDate, true);
  assert.ok(status.output.date instanceof Date);
  assert.equal(status.output.date.toISOString(), "2026-09-26T00:00:00.000Z");
  assert.equal(status.output.mapIsMap, true);
  assert.ok(status.output.map instanceof Map);
  assert.equal(status.output.map.get("answer"), 42);
  assert.equal(status.output.setIsSet, true);
  assert.ok(status.output.set instanceof Set);
  assert.deepEqual([...status.output.set], ["a", "b"]);
  assert.equal(status.output.bytesIsUint8Array, true);
  assert.ok(status.output.bytes instanceof Uint8Array);
  assert.deepEqual([...status.output.bytes], [1, 2, 255]);
  assert.equal(status.output.bigintIsBigInt, true);
  assert.equal(status.output.bigint, 9007199254740993n);
});

test("outer step.do makes Promise.race winner durable across replay", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-race-replay-");
  const runtime = await openRuntime(e2eConfig, paths);
  const instance = await runtime.trigger(
    "wrapped-race",
    {
      id: "wrapped-race-1",
      params: { baseUrl: counter.baseUrl, sleepMs: 500 },
    },
    { run: false },
  );
  runtime.close();

  const first = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(first, "SIGKILL"));
  await poll(() => {
    const rows = dbSnapshot(
      paths.storagePath,
      "SELECT name, state FROM steps WHERE instance_id=? ORDER BY ordinal",
      instance.id,
    );
    return rows.some(
      (row) => row.name === "race-pause" && row.state === "waiting",
    ) ? rows : null;
  });
  await stopChild(first, "SIGKILL");
  assert.equal(counter.counts.get("/race-fast"), 1);

  const second = spawnDev(e2eConfig, paths);
  t.after(() => stopChild(second, "SIGKILL"));
  await poll(() => {
    const [row] = dbSnapshot(
      paths.storagePath,
      "SELECT status, output FROM instances WHERE public_id=? AND workflow_name='wrapped-race'",
      instance.id,
    );
    return row?.status === "complete" ? row : null;
  }, { timeout: 5000 });
  await stopChild(second, "SIGTERM");

  const verify = await openRuntime(e2eConfig, paths);
  t.after(() => verify.close());
  assert.deepEqual(
    verify.instanceStatus(instance.id, "wrapped-race").output,
    { winner: "fast", count: 1 },
  );
  const postRace = verify.storage.listSteps(
    verify.requireInstance(instance.id, "wrapped-race").id,
  ).find((step) => step.name === "race-after-replay");
  assert.equal(postRace.ordinal, 3);
  assert.equal(counter.counts.get("/race-fast"), 1);
});


test("sensitive step output stays durable but is redacted from subscriptions", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-sensitive-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("sensitive", {
    id: "sensitive-1",
    params: {},
  });
  assert.deepEqual(runtime.instanceStatus(instance.id, "sensitive").output, {
    preserved: true,
  });

  const events = await collectSubscriptionEvents(instance, {
    filter: ["step_completed", "workflow_completed"],
  });
  assert.equal(events[0].type, "step_completed");
  assert.equal(events[0].stepName, "sensitive-output");
  assert.equal(events[0].output, "[REDACTED]");
  assert.deepEqual(events[1].output, { preserved: true });

  const row = runtime.storage.getInstanceByPublic("sensitive", instance.id);
  const step = runtime.storage.listSteps(row.id).find(
    (candidate) => candidate.name === "sensitive-output",
  );
  assert.deepEqual(
    decodeDurableValueForTest(step.output),
    { token: "super-secret", visibleToWorkflow: true },
  );
});


test("resume is an idempotent no-op when the workflow is not paused", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-resume-noop-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const complete = await runtime.trigger("duplicate", {
    id: "resume-complete",
    params: {},
  });
  assert.equal(runtime.instanceStatus(complete.id, "duplicate").status, "complete");
  await complete.resume();
  assert.equal(runtime.instanceStatus(complete.id, "duplicate").status, "complete");

  const waiting = await runtime.trigger("approval", {
    id: "resume-waiting",
    params: {},
  });
  assert.equal(runtime.instanceStatus(waiting.id, "approval").status, "waiting");
  await waiting.resume();
  assert.equal(runtime.instanceStatus(waiting.id, "approval").status, "waiting");
});


test("step context exposes Cloudflare default retry and 10 minute timeout config", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-default-config-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("default-config", {
    id: "default-config-1",
    params: {},
  });
  const status = runtime.instanceStatus(instance.id, "default-config");
  assert.equal(status.status, "complete");
  assert.deepEqual(status.output, {
    retries: { limit: 5, delay: 10000, backoff: "exponential" },
    timeout: "10 minutes",
  });
});


test("allSettled cannot swallow a durable event suspension", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-parallel-wait-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger("parallel-wait", {
    id: "parallel-wait-1",
    params: { baseUrl: counter.baseUrl },
  });
  assert.equal(runtime.instanceStatus(instance.id, "parallel-wait").status, "waiting");
  assert.equal(counter.counts.get("/parallel-before-event"), 1);

  await instance.sendEvent({
    type: "approved",
    payload: { approved: true },
  });
  await runtime.runPending();
  const status = runtime.instanceStatus(instance.id, "parallel-wait");
  assert.equal(status.status, "complete");
  assert.equal(counter.counts.get("/parallel-before-event"), 1);
  assert.deepEqual(status.output.fulfilled, [
    "ready",
    {
      type: "approved",
      payload: { approved: true },
      timestamp: status.output.fulfilled[1].timestamp,
    },
  ]);
  assert.ok(status.output.fulfilled[1].timestamp instanceof Date);
});


test("workflow-scoped internal ids cannot collide with user-constructible ids", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-storage-id-collision-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const crafted = "wf:error:shared";
  const craftedInstance = await runtime.env().DUPLICATE.create({
    id: crafted,
    params: {},
  });
  const firstShared = await runtime.env().DUPLICATE.create({
    id: "shared",
    params: {},
  });
  const secondShared = await runtime.env().ERROR.create({
    id: "shared",
    params: {},
  });

  const craftedRow = runtime.storage.getInstanceByPublic("duplicate", crafted);
  const firstRow = runtime.storage.getInstanceByPublic("duplicate", "shared");
  const secondRow = runtime.storage.getInstanceByPublic("error", "shared");

  assert.ok(craftedRow);
  assert.ok(firstRow);
  assert.ok(secondRow);
  assert.equal(craftedInstance.id, crafted);
  assert.equal(firstShared.id, "shared");
  assert.equal(secondShared.id, "shared");
  assert.notEqual(secondRow.id, craftedRow.id);
  assert.notEqual(secondRow.id, firstRow.id);
  assert.match(secondRow.id, /^wf_[0-9a-f-]{36}$/i);
});

test("ctx.waitUntil does not block the Worker HTTP response", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-wait-until-");
  const runtime = await openRuntime(basicConfig, paths);
  t.after(() => runtime.close());

  const server = await startWorkflowHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const target = encodeURIComponent(`${counter.baseUrl}/background`);

  const response = await fetch(
    `http://127.0.0.1:${address.port}/wait-until?target=${target}`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "accepted");
  assert.equal(counter.counts.get("/background"), undefined);
  assert.equal(runtime.backgroundTasks.size, 1);

  await poll(() => counter.counts.get("/background") === 1);
  await poll(() => runtime.backgroundTasks.size === 0);
});

test("Worker ReadableStream response reaches the client incrementally", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-worker-stream-");
  const runtime = await openRuntime(basicConfig, paths);
  t.after(() => runtime.close());

  const server = await startWorkflowHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/stream`);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(decoder.decode(first.value), "first\n");

  const secondPromise = reader.read();
  const beforeDelay = await Promise.race([
    secondPromise.then(() => "chunk"),
    wait(50).then(() => "waiting"),
  ]);
  assert.equal(beforeDelay, "waiting");

  const second = await secondPromise;
  assert.equal(second.done, false);
  assert.equal(decoder.decode(second.value), "second\n");
  assert.equal((await reader.read()).done, true);
});

test("deleting a running instance stops execution without crashing the scheduler", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-delete-running-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger(
    "pause",
    {
      id: "delete-running-1",
      params: { baseUrl: counter.baseUrl },
    },
    { run: false },
  );
  const row = runtime.storage.getInstanceByPublic("pause", instance.id);
  const running = runtime.runInstance(row.id);

  await poll(() => {
    const [attempt] = dbSnapshot(
      paths.storagePath,
      "SELECT state FROM attempts WHERE instance_id=? ORDER BY started_at DESC LIMIT 1",
      row.id,
    );
    return attempt?.state === "running";
  });

  await instance.delete();
  await running;
  await runtime.runPending();

  assert.equal(runtime.storage.getInstanceByPublic("pause", instance.id), null);
  assert.equal(counter.counts.get("/slow"), 1);
  assert.equal(counter.counts.get("/after-pause"), undefined);
});

test("a workflow deleting itself stops at await instance.delete()", async (t) => {
  const counter = await startCounterServer();
  t.after(() => counter.server.close());
  const paths = tempRuntimePaths("workflows-mbt-self-delete-");
  const runtime = await openRuntime(e2eConfig, paths);
  t.after(() => runtime.close());

  const instance = await runtime.trigger(
    "self-delete",
    {
      id: "self-delete-1",
      params: { baseUrl: counter.baseUrl },
    },
    { run: false },
  );
  const row = runtime.storage.getInstanceByPublic("self-delete", instance.id);

  await runtime.runInstance(row.id);
  await runtime.runPending();

  assert.equal(runtime.storage.getInstanceByPublic("self-delete", instance.id), null);
  assert.equal(counter.counts.get("/after-self-delete"), undefined);
});


test("default Worker preserves multiple Set-Cookie response headers", async (t) => {
  const paths = tempRuntimePaths("workflows-mbt-worker-cookies-");
  const runtime = await openRuntime(basicConfig, paths);
  t.after(() => runtime.close());

  const server = await startWorkflowHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/cookies`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cookie-test"), "ok");
  assert.deepEqual(response.headers.getSetCookie(), [
    "first=one; Path=/; HttpOnly",
    "second=two; Path=/; SameSite=Lax",
  ]);
  assert.equal(await response.text(), "cookies");
});
