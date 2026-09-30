import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleWranglerLocalExplorer } from "../host/local-explorer.mjs";
import { startWorkflowHttpServer } from "../host/server.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeRuntime() {
  const rows = new Map();
  let sequence = 0;
  const workflow = {
    name: "demo-workflow",
    binding: "DEMO_WORKFLOW",
    className: "DemoWorkflow",
  };

  const runtime = {
    config: {
      name: "demo-worker",
      workflows: [workflow],
    },
    workflowByName: new Map([[workflow.name, workflow]]),
    storage: {
      deleteExpired() {},
      listInstances(name) {
        const selected = [...rows.values()].filter((row) => row.workflow_name === name);
        return { rows: selected, total: selected.length };
      },
      listExecutionEvents() {
        return [];
      },
      listSteps() {
        return [];
      },
      listAttempts() {
        return [];
      },
      deleteInstance(storageId) {
        const row = [...rows.values()].find((candidate) => candidate.id === storageId);
        if (!row) return false;
        rows.delete(row.public_id);
        return true;
      },
    },
    async createInstance(name, options = {}) {
      if (name !== workflow.name) throw new Error(`Unknown workflow: ${name}`);
      const id = options.id ?? `generated-${++sequence}`;
      if (rows.has(id)) throw new Error(`Workflow instance already exists: ${id}`);
      const now = Date.now() + sequence;
      rows.set(id, {
        id: `storage-${id}`,
        public_id: id,
        workflow_name: name,
        status: "queued",
        payload: JSON.stringify(options.params ?? {}),
        output: null,
        error: null,
        created_at: now,
        updated_at: now,
      });
      return { id };
    },
    requireInstance(id, name) {
      const row = rows.get(id);
      if (!row || (name != null && row.workflow_name !== name)) {
        throw new Error(`Workflow instance not found: ${id}`);
      }
      return row;
    },
    async fetch() {
      return new Response("not found", { status: 404 });
    },
  };

  function handleFor(id) {
    const row = () => runtime.requireInstance(id, workflow.name);
    return {
      async status() {
        return { status: row().status };
      },
      async pause() {
        row().status = "paused";
      },
      async resume() {
        row().status = "queued";
      },
      async restart() {
        row().status = "queued";
      },
      async terminate() {
        row().status = "terminated";
      },
      async delete() {
        runtime.storage.deleteInstance(row().id);
      },
      async sendEvent(event) {
        row().lastEvent = event;
      },
    };
  }

  runtime.env = () => ({
    DEMO_WORKFLOW: {
      async get(id) {
        runtime.requireInstance(id, workflow.name);
        return handleFor(id);
      },
      async deleteBatch(ids) {
        const deleted = [];
        const errors = [];
        for (const id of ids) {
          const row = rows.get(id);
          if (!row) {
            errors.push({ id, code: 10400, message: "Workflow instance not found" });
            continue;
          }
          runtime.storage.deleteInstance(row.id);
          deleted.push({ id });
        }
        return { deleted, errors };
      },
    },
  });

  return { runtime, rows };
}

async function jsonResponse(runtime, path, init = undefined) {
  const response = await handleWranglerLocalExplorer(
    runtime,
    new Request(`http://localhost${path}`, init),
  );
  assert.ok(response);
  const body = await response.json();
  return { response, body };
}

test("Wrangler local explorer routes expose workflow and instance lifecycle", async () => {
  const { runtime, rows } = makeRuntime();
  const base = "/cdn-cgi/local/explorer/api";

  let result = await jsonResponse(runtime, `${base}/workflows`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.result, [{
    name: "demo-workflow",
    class_name: "DemoWorkflow",
    script_name: "demo-worker",
  }]);

  result = await jsonResponse(runtime, `${base}/workflows/demo-workflow/instances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "instance-a", params: { answer: 42 } }),
  });
  assert.equal(result.body.result.id, "instance-a");

  result = await jsonResponse(runtime, `${base}/workflows/demo-workflow/instances`);
  assert.equal(result.body.result.length, 1);
  assert.equal(result.body.result[0].id, "instance-a");
  assert.equal(result.body.result[0].status, "queued");

  result = await jsonResponse(
    runtime,
    `${base}/workflows/demo-workflow/instances/instance-a/status`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "pause" }),
    },
  );
  assert.equal(result.body.result.status, "paused");

  result = await jsonResponse(
    runtime,
    `${base}/workflows/demo-workflow/instances/instance-a/events/approved`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
  );
  assert.equal(result.body.result.success, true);
  assert.deepEqual(rows.get("instance-a").lastEvent, {
    type: "approved",
    payload: { ok: true },
  });

  result = await jsonResponse(runtime, `${base}/workflows/demo-workflow/instances/batch/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instances: ["instance-a", "missing"] }),
  });
  assert.deepEqual(result.body.result.deleted, [{ id: "instance-a" }]);
  assert.equal(result.body.result.errors[0].id, "missing");
});

test("real Wrangler CLI can list workflows from workflows.mbt local API", async (t) => {
  const wranglerCli = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const { runtime } = makeRuntime();
  const server = await startWorkflowHttpServer(runtime, { host: "localhost", port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, "object");
  const cwd = mkdtempSync(join(tmpdir(), "workflows-mbt-wrangler-"));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      wranglerCli,
      "workflows",
      "list",
      "--local",
      "--port",
      String(address.port),
      "--json",
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );

  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, [{
    name: "demo-workflow",
    script_name: "demo-worker",
    class_name: "DemoWorkflow",
  }]);
});
