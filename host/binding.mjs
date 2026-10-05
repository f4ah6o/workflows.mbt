import {
  WorkflowInstanceDeletedExecution,
  workflowExecutionScope,
} from "./execution-scope.mjs";
import { WorkflowSubscription } from "./subscription.mjs";

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

  async createBatch(batch) {
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 100) {
      throw new TypeError("createBatch expects 1..100 instance options");
    }
    for (const item of batch) {
      if (!item || typeof item.id !== "string" || !("params" in item)) {
        throw new TypeError("createBatch items require id and params");
      }
    }
    this.runtime.storage.deleteExpired(Date.now());
    const out = [];
    for (const item of batch) {
      const existing = this.runtime.storage.getInstanceByPublic(
        this.workflow.name,
        item.id,
      );
      if (existing) continue;
      out.push(await this.create(item));
    }
    return out;
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
