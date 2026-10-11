import {
  WorkflowInstanceDeletedExecution,
  workflowExecutionScope,
} from "./execution-scope.mjs";
import { WorkflowSubscription } from "./subscription.mjs";
import { serializeJson } from "./serialization.mjs";

function bindingMissingInstanceError(error, id) {
  // Storage/runtime errors retain their internal message for REST callers.
  if (error?.message === `Workflow instance not found: ${id}`) {
    return new Error("instance.not_found");
  }
  return error;
}

function callBindingOperation(id, operation) {
  try {
    return operation();
  } catch (error) {
    throw bindingMissingInstanceError(error, id);
  }
}

async function callAsyncBindingOperation(id, operation) {
  try {
    return await operation();
  } catch (error) {
    throw bindingMissingInstanceError(error, id);
  }
}

const LOCATION_HINTS = [
  "wnam", "weur", "enam", "eeur", "apac", "apac-ne", "apac-se", "oc", "sam", "afr", "me",
];
const RETENTION_DURATION_ERROR = "Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.";

function batchError(message, code = "body") {
  // RPC exposes upstream WorkflowError as an ordinary Error at the binding.
  return new Error(`(${code}) ${message}`);
}

function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Match the candidate's batch retention parser, including its numeric strings
// and space-separated units. This is deliberately scoped to the new overload:
// existing step/retention parsing keeps its established compatibility policy.
function batchRetentionMilliseconds(value) {
  if (typeof value === "number") return value;
  if (!Number.isNaN(Number(value))) return Number(value);
  const match = value.match(/^([^ ]+) +(\w\w*?)s?$/);
  if (!match) return NaN;
  const units = {
    year: 31_557_600_000, month: 2_592_000_000, week: 604_800_000,
    day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000, m: 1,
  };
  return Number(match[1]) * (units[match[2]] ?? 1);
}

function validateBatchInstance(options) {
  if (!isObject(options)) {
    throw batchError(`Invalid input: expected object, received ${valueType(options)}`);
  }
  const issues = [];
  if (options.id !== undefined && typeof options.id !== "string") {
    issues.push(`Invalid input: expected string, received ${valueType(options.id)}`);
  }
  let retention;
  if (options.retention !== undefined) {
    if (!isObject(options.retention)) {
      issues.push(`Invalid input: expected object, received ${valueType(options.retention)}`);
    } else {
      retention = {};
      for (const key of ["successRetention", "errorRetention"]) {
        const value = options.retention[key];
        if (value === undefined) continue;
        if (!["number", "string"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
          issues.push("Invalid input");
          continue;
        }
        const ms = batchRetentionMilliseconds(value);
        if (!Number.isFinite(ms) || ms <= 0 || (typeof value === "number" && !Number.isInteger(value))) {
          issues.push(RETENTION_DURATION_ERROR);
          continue;
        }
        retention[key] = ms;
      }
    }
  }
  if (options.locationHint !== undefined && !LOCATION_HINTS.includes(options.locationHint)) {
    issues.push(`Invalid option: expected one of ${LOCATION_HINTS.map((hint) => JSON.stringify(hint)).join("|")}`);
  }
  if (issues.length) throw batchError(issues.join("; "));
  if (options.id !== undefined && (
    options.id.length > 100 || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(options.id) ||
    ["batch", "terminate", "terminateAll"].includes(options.id) || /^cf_[0-9a-f]{64}$/.test(options.id)
  )) {
    throw batchError("Instance ID is invalid", "instance.invalid_id");
  }
  return { ...options, retention };
}

export class WorkflowBinding {
  constructor(runtime, workflow) {
    this.runtime = runtime;
    this.workflow = workflow;
  }

  async create(options = {}) {
    try {
      return await this.runtime.createInstance(this.workflow.name, options);
    } catch (error) {
      if (error?.alreadyExists !== true) throw error;
      // Keep the storage sentinel internal; Workflow binding callers receive
      // Cloudflare's plain Error shape.
      const internalPrefix = "Workflow instance already exists: ";
      const internalId = error.message?.startsWith(internalPrefix)
        ? error.message.slice(internalPrefix.length)
        : undefined;
      const id = options?.id ?? internalId;
      throw new Error(
        `(instance.already_exists) Workflow instance with id ${JSON.stringify(id)} already exists`,
      );
    }
  }

  async get(id) {
    callBindingOperation(id, () =>
      this.runtime.requireInstance(id, this.workflow.name)
    );
    return new WorkflowInstanceHandle(this.runtime, this.workflow.name, id);
  }

  async createBatch(options) {
    const legacy = Array.isArray(options);
    let batch;
    if (legacy) {
      batch = options;
      if (batch.length < 1 || batch.length > 100) {
        throw new TypeError("createBatch expects 1..100 instance options");
      }
      for (const item of batch) {
        if (!isObject(item) || (item.id !== undefined && typeof item.id !== "string")) {
          throw new TypeError("createBatch items must be instance options");
        }
      }
    } else {
      if (!isObject(options)) throw batchError("Provided argument is invalid");
      if ("count" in options && options.count !== undefined) {
        if (!Number.isInteger(options.count) || options.count <= 0) {
          throw batchError("count must be a positive integer");
        }
        if (options.count > 100) {
          throw batchError("batchCreate only supports 100 instances at a time");
        }
        batch = Array.from({ length: options.count }, () => ({
          params: options.params,
          retention: options.retention,
          locationHint: options.locationHint,
        }));
      } else if (Array.isArray(options.instances)) {
        batch = options.instances;
      } else {
        throw batchError("Provided argument is invalid");
      }
      if (batch.length < 1 || batch.length > 100) {
        throw batchError("Batch size exceeds maximum allowed");
      }
      // Validate every position before creating anything. Invalid options reject
      // the call; duplicate IDs are the indexed partial-error result cases.
      batch = batch.map(validateBatchInstance);
      // Local workflow params use JSON persistence, which is narrower than
      // Workers RPC values (e.g. BigInt/cycles). Snapshot every payload before
      // writing, so a local serialization rejection cannot create half a batch.
      // Passing the snapshots also prevents a second toJSON/getter evaluation
      // from failing after earlier instances have already been stored.
      batch = batch.map((item) => ({
        ...item,
        params: JSON.parse(serializeJson(
          item.params === undefined ? {} : item.params,
          "workflow params",
        )),
      }));
    }
    this.runtime.storage.deleteExpired(Date.now());
    const existing = new Set(batch.flatMap((item) =>
      item.id !== undefined && this.runtime.storage.getInstanceByPublic(this.workflow.name, item.id)
        ? [item.id] : [],
    ));
    const seen = new Set();
    const result = { created: [], errors: [] };
    for (const [index, item] of batch.entries()) {
      if (item.id !== undefined) {
        if (seen.has(item.id)) {
          if (!legacy) result.errors.push({
            index, id: item.id, code: 10415,
            message: "workflows.api.error.instance.duplicate_in_batch",
          });
          continue;
        }
        seen.add(item.id);
        if (existing.has(item.id)) {
          if (!legacy) result.errors.push({
            index, id: item.id, code: 10405,
            message: "workflows.api.error.instance.already_exists",
          });
          continue;
        }
      }
      result.created.push(await this.create(item));
    }
    return legacy ? result.created : result;
  }

  async deleteBatch(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      throw new TypeError("deleteBatch expects 1..100 instance IDs");
    }
    if (ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 100)) {
      throw new TypeError("deleteBatch instance IDs must be 1..100 character strings");
    }
    this.runtime.storage.deleteExpired(Date.now());
    const deleted = [];
    const errors = [];
    const outcomes = new Map();
    for (const id of ids) {
      let outcome = outcomes.get(id);
      if (!outcome) {
        const row = this.runtime.storage.getInstanceByPublic(
          this.workflow.name,
          id,
        );
        if (row) {
          this.runtime.storage.deleteInstance(row.id);
          outcome = { ok: true };
        } else {
          outcome = {
            ok: false,
            error: { id, code: 10400, message: "Workflow instance not found" },
          };
        }
        outcomes.set(id, outcome);
      }
      if (outcome.ok) deleted.push({ id });
      else errors.push({ ...outcome.error });
    }
    return { deleted, errors };
  }
}

export class WorkflowInstanceHandle {
  constructor(runtime, workflowName, id) {
    this.runtime = runtime;
    this.workflowName = workflowName;
    this.id = id;
  }

  row() {
    return callBindingOperation(this.id, () =>
      this.runtime.requireInstance(this.id, this.workflowName)
    );
  }

  async status() {
    return callAsyncBindingOperation(this.id, () =>
      this.runtime.instanceStatus(this.id, this.workflowName)
    );
  }

  async pause() {
    const row = this.row();
    if (["complete", "errored", "terminated", "paused"].includes(row.status)) {
      throw new Error(`Cannot pause instance in state ${row.status}`);
    }
    this.runtime.storage.setInstanceStatus(
      row.id,
      row.status === "running" ? "waitingForPause" : "paused",
    );
  }

  async resume() {
    const row = this.row();
    if (!["paused", "waitingForPause"].includes(row.status)) return;
    this.runtime.storage.setInstanceStatus(row.id, "queued");
  }

  async restart(options = undefined) {
    const row = this.row();
    this.runtime.storage.restartInstance(row.id, options?.from ?? null);
  }

  async terminate(options = undefined) {
    const row = this.row();
    if (["complete", "errored", "terminated"].includes(row.status)) {
      throw new Error(`Cannot terminate instance in state ${row.status}`);
    }
    const keys = options == null ? [] : Object.keys(options);
    if (keys.some((key) => key !== "rollback")) {
      throw new TypeError("terminate only accepts the rollback option");
    }
    if (options?.rollback === true) {
      this.runtime.storage.beginRollback(row.id, {
        terminalStatus: "terminated",
        cause: null,
      });
      return;
    }
    this.runtime.storage.setInstanceStatus(row.id, "terminated");
  }

  async delete() {
    const row = this.row();
    if (!this.runtime.storage.deleteInstance(row.id)) {
      throw new Error("instance.not_found");
    }
    if (workflowExecutionScope.getStore()?.instanceStorageId === row.id) {
      throw new WorkflowInstanceDeletedExecution(row.id);
    }
  }

  async sendEvent(event) {
    return callAsyncBindingOperation(this.id, () =>
      this.runtime.sendEvent(this.id, event, this.workflowName)
    );
  }

  async subscribe(options = {}) {
    const row = this.row();
    return new WorkflowSubscription(
      this.runtime,
      row.id,
      this.id,
      options,
    );
  }
}
