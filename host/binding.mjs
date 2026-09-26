import { WorkflowSubscription } from "./subscription.mjs";
export class WorkflowBinding {
  constructor(runtime, workflow) {
    this.runtime = runtime;
    this.workflow = workflow;
  }

  async create(options = {}) {
    return this.runtime.createInstance(this.workflow.name, options);
  }

  async get(id) {
    const instance = this.runtime.requireInstance(id);
    if (!instance || instance.workflow_name !== this.workflow.name) {
      throw new Error(`Workflow instance not found: ${id}`);
    }
    return new WorkflowInstanceHandle(this.runtime, id);
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
      const existing = this.runtime.storage.getInstance(item.id);
      if (existing) {
        if (existing.workflow_name === this.workflow.name) continue;
        throw new Error(
          `Instance id ${item.id} is already used by another workflow in the SQLite v1 namespace`,
        );
      }
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
        const row = this.runtime.storage.getInstance(id);
        if (row && row.workflow_name === this.workflow.name) {
          this.runtime.storage.deleteInstance(id);
          outcome = { ok: true };
        } else {
          outcome = {
            ok: false,
            error: { id, code: 404, message: "Workflow instance not found" },
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
  constructor(runtime, id) {
    this.runtime = runtime;
    this.id = id;
  }

  async status() {
    return this.runtime.instanceStatus(this.id);
  }

  async pause() {
    const row = this.runtime.requireInstance(this.id);
    if (["complete", "errored", "terminated", "paused"].includes(row.status)) {
      throw new Error(`Cannot pause instance in state ${row.status}`);
    }
    this.runtime.storage.setInstanceStatus(
      this.id,
      row.status === "running" ? "waitingForPause" : "paused",
    );
  }

  async resume() {
    const row = this.runtime.requireInstance(this.id);
    if (!["paused", "waitingForPause"].includes(row.status)) {
      throw new Error(`Cannot resume instance in state ${row.status}`);
    }
    this.runtime.storage.setInstanceStatus(this.id, "queued");
  }

  async restart(options = undefined) {
    this.runtime.storage.restartInstance(this.id, options?.from ?? null);
  }

  async terminate(options = undefined) {
    const row = this.runtime.requireInstance(this.id);
    if (["complete", "errored", "terminated"].includes(row.status)) {
      throw new Error(`Cannot terminate instance in state ${row.status}`);
    }
    const keys = options == null ? [] : Object.keys(options);
    if (keys.some((key) => key !== "rollback")) {
      throw new TypeError("terminate only accepts the rollback option");
    }
    if (options?.rollback === true) {
      this.runtime.storage.beginRollback(this.id, {
        terminalStatus: "terminated",
        cause: null,
      });
      return;
    }
    this.runtime.storage.setInstanceStatus(this.id, "terminated");
  }

  async delete() {
    if (!this.runtime.storage.deleteInstance(this.id)) {
      throw new Error(`Workflow instance not found: ${this.id}`);
    }
  }

  async sendEvent(event) {
    return this.runtime.sendEvent(this.id, event);
  }

  async subscribe(options = {}) {
    this.runtime.requireInstance(this.id);
    return new WorkflowSubscription(this.runtime, this.id, options);
  }
}
