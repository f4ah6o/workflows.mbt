import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowBinding, WorkflowInstanceHandle } from "../host/binding.mjs";
import { WorkflowRuntime } from "../host/engine.mjs";
import { SQLiteStorage } from "../host/storage/sqlite.mjs";

// Exercises the real creation/storage path without needing a scheduler or kernel.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wf-batch-contract-"));
  const storage = new SQLiteStorage(join(dir, "state.sqlite"));
  const workflow = { name: "batch", binding: "BATCH", className: "BatchWorkflow", main: "unused.ts" };
  storage.registerWorkflow(workflow);
  const runtime = new WorkflowRuntime({ config: { workflows: [workflow] }, kernel: null, storage, env: {} });
  const binding = new WorkflowBinding(runtime, workflow);
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  return { storage, runtime, workflow, binding };
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

test("createBatch count creates unique generated handles and preserves params", async (t) => {
  const { binding, storage } = fixture(t);
  const result = await binding.createBatch({ count: 3, params: { value: 42 } });
  assert.deepEqual(Object.keys(result), ["created", "errors"]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.created.length, 3);
  assert.equal(new Set(result.created.map((handle) => handle.id)).size, 3);
  for (const handle of result.created) {
    assert.ok(handle instanceof WorkflowInstanceHandle);
    assert.match(handle.id, uuid);
    assert.equal((await handle.status()).status, "queued");
    assert.deepEqual(JSON.parse(storage.getInstanceByPublic("batch", handle.id).payload), { value: 42 });
  }
  const defaults = await binding.createBatch({ instances: [{}, { params: null }] });
  assert.deepEqual(defaults.created.map((handle) => JSON.parse(storage.getInstanceByPublic("batch", handle.id).payload)), [{}, null]);
});

test("createBatch object reports stable indexed duplicate errors and input-order successes", async (t) => {
  const { binding } = fixture(t);
  await binding.create({ id: "existing" });
  const result = await binding.createBatch({ instances: [
    { id: "existing" }, { id: "existing" }, {}, { id: "fresh" }, { id: "fresh" }, {},
  ] });
  assert.equal(result.created.length, 3);
  assert.match(result.created[0].id, uuid);
  assert.equal(result.created[1].id, "fresh");
  assert.match(result.created[2].id, uuid);
  assert.deepEqual(result.errors, [
    { index: 0, id: "existing", code: 10405, message: "workflows.api.error.instance.already_exists" },
    { index: 1, id: "existing", code: 10415, message: "workflows.api.error.instance.duplicate_in_batch" },
    { index: 4, id: "fresh", code: 10415, message: "workflows.api.error.instance.duplicate_in_batch" },
  ]);
  const again = await binding.createBatch({ instances: [{ id: "fresh" }] });
  assert.deepEqual(again.created, []);
  assert.equal(again.errors[0].code, 10405);
});

test("legacy createBatch retains array result and omission semantics, with optional ids/params", async (t) => {
  const { binding } = fixture(t);
  await binding.create({ id: "existing" });
  const result = await binding.createBatch([{ id: "existing" }, { id: "fresh" }, {}, { id: "fresh" }]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "fresh");
  assert.match(result[1].id, uuid);
});

test("createBatch validates the entire object input before creating any instance", async (t) => {
  const { binding, storage } = fixture(t);
  for (const bad of [
    { id: "" }, { id: "bad id" }, { id: "-bad" }, { id: "a".repeat(101) },
    { id: "batch" }, { id: "terminate" }, { id: "terminateAll" }, { id: "cf_" + "a".repeat(64) },
  ]) {
    await assert.rejects(binding.createBatch({ instances: [{ id: "must-not-exist" }, bad] }), {
      name: "Error", message: "(instance.invalid_id) Instance ID is invalid",
    });
    assert.equal(storage.getInstanceByPublic("batch", "must-not-exist"), null);
  }
  const upper = "cf_" + "A".repeat(64);
  assert.equal((await binding.createBatch({ instances: [{ id: upper }] })).created[0].id, upper);
});

test("createBatch count, list and option validation follows candidate errors", async (t) => {
  const { binding } = fixture(t);
  const badBodies = [undefined, null, false, 1, "bad", {}, { instances: "bad" }];
  for (const value of badBodies) await assert.rejects(binding.createBatch(value), {
    name: "Error", message: "(body) Provided argument is invalid",
  });
  for (const count of [0, -1, 1.5, "1", null, NaN, Infinity]) await assert.rejects(binding.createBatch({ count }), {
    name: "Error", message: "(body) count must be a positive integer",
  });
  await assert.rejects(binding.createBatch({ count: 101 }), { message: "(body) batchCreate only supports 100 instances at a time" });
  for (const instances of [[], Array.from({ length: 101 }, () => ({}))]) await assert.rejects(binding.createBatch({ instances }), {
    message: "(body) Batch size exceeds maximum allowed",
  });
  for (const [value, type] of [[null, "null"], [1, "number"], [[], "array"], [false, "boolean"]]) {
    await assert.rejects(binding.createBatch({ instances: [value] }), { message: `(body) Invalid input: expected object, received ${type}` });
  }
  await assert.rejects(binding.createBatch({ instances: [{ id: null }] }), { message: "(body) Invalid input: expected string, received null" });
  // The implementation follows runtime branch selection; TS excludes these.
  assert.equal((await binding.createBatch({ count: 1, instances: [{ id: "bad id" }] })).created.length, 1);
  assert.equal((await binding.createBatch({ count: undefined, instances: [{}] })).created.length, 1);
  assert.equal((await binding.createBatch({ count: 100 })).created.length, 100);
});

test("createBatch retention validates before writing and preserves durable policies", async (t) => {
  const { binding, storage } = fixture(t);
  const durationError = "(body) Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.";
  for (const value of [0, -1, 1.5, "0 seconds", "tomorrow", "10ms"]) {
    await assert.rejects(binding.createBatch({ instances: [{ id: "not-written" }, { retention: { successRetention: value } }] }), {
      name: "Error", message: durationError,
    });
    assert.equal(storage.getInstanceByPublic("batch", "not-written"), null);
  }
  for (const value of [true, null, {}, NaN, Infinity]) await assert.rejects(binding.createBatch({ count: 1, retention: { errorRetention: value } }), {
    message: "(body) Invalid input",
  });
  await assert.rejects(binding.createBatch({ count: 1, retention: null }), {
    message: "(body) Invalid input: expected object, received null",
  });
  const result = await binding.createBatch({ count: 2, retention: { successRetention: "1.5 seconds", errorRetention: 1000 } });
  for (const handle of result.created) {
    const row = storage.getInstanceByPublic("batch", handle.id);
    assert.equal(row.success_retention_ms, 1500);
    assert.equal(row.error_retention_ms, 1000);
  }
  const millis = await binding.createBatch({ instances: [{ retention: { successRetention: "1 ms", errorRetention: "250" } }] });
  const row = storage.getInstanceByPublic("batch", millis.created[0].id);
  assert.equal(row.success_retention_ms, 1);
  assert.equal(row.error_retention_ms, 250);
});

test("createBatch accepts candidate location hints without claiming geographic placement", async (t) => {
  const { binding } = fixture(t);
  const hints = ["wnam", "weur", "enam", "eeur", "apac", "apac-ne", "apac-se", "oc", "sam", "afr", "me"];
  assert.equal((await binding.createBatch({ instances: hints.map((locationHint) => ({ locationHint })) })).created.length, hints.length);
  for (const locationHint of ["moon", null, 1]) await assert.rejects(binding.createBatch({ count: 1, locationHint }), {
    message: `(body) Invalid option: expected one of ${hints.map((hint) => JSON.stringify(hint)).join("|")}`,
  });
});

test("createBatch retains workflow-scoped duplicate detection", async (t) => {
  const { binding, runtime, storage } = fixture(t);
  const other = { name: "other", binding: "OTHER", className: "Other", main: "unused.ts" };
  storage.registerWorkflow(other);
  runtime.workflowByName.set(other.name, other);
  await new WorkflowBinding(runtime, other).create({ id: "shared" });
  assert.equal((await binding.createBatch({ instances: [{ id: "shared" }] })).created[0].id, "shared");
});


test("object batches preflight unsupported local JSON payloads before any writes", async (t) => {
  const { binding, storage } = fixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const params of [1n, cyclic, () => 42, Symbol("unsupported")]) {
    await assert.rejects(binding.createBatch({ instances: [{ id: "not-written" }, { params }] }), {
      name: "WorkflowSerializationError",
    });
    assert.equal(storage.getInstanceByPublic("batch", "not-written"), null);
  }
  await binding.create({ id: "existing", params: { original: true } });
  await assert.rejects(binding.createBatch({ instances: [
    { id: "not-written" }, { id: "existing", params: 1n },
  ] }), { name: "WorkflowSerializationError" });
  assert.equal(storage.getInstanceByPublic("batch", "not-written"), null);
  assert.deepEqual(JSON.parse(storage.getInstanceByPublic("batch", "existing").payload), { original: true });
  let calls = 0;
  const result = await binding.createBatch({ instances: [{ params: {
    toJSON() {
      calls += 1;
      if (calls > 1) throw new Error("must not serialize input twice");
      return { snapshotted: true };
    },
  } }] });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(storage.getInstanceByPublic("batch", result.created[0].id).payload), { snapshotted: true });
});
