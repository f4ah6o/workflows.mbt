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
    const instance = this.runtime.storage.getInstance(id);
    if (!instance || instance.workflow_name !== this.workflow.name) {
      throw new Error(`Workflow instance not found: ${id}`);
    }
    return new WorkflowInstanceHandle(this.runtime, id);
  }

  async createBatch(batch) {
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 100) {
      throw new TypeError("createBatch expects 1..100 instance options");
    }
    const out = [];
    for (const item of batch) {
      try {
        const existing = item.id && this.runtime.storage.getInstance(item.id);
        if (existing) continue;
        out.push(await this.create(item));
      } catch (error) {
        if (!String(error?.message).includes("UNIQUE")) throw error;
      }
    }
    return out;
  }

  async deleteBatch(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) {
      throw new TypeError("deleteBatch expects 1..100 instance IDs");
    }
    const deleted = [];
    const errors = [];
    for (const id of ids) {
      if (this.runtime.storage.deleteInstance(id)) deleted.push({ id });
      else errors.push({ id, code: 404, message: "Workflow instance not found" });
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
    if (["complete", "errored", "terminated"].includes(row.status)) {
      throw new Error(`Cannot pause instance in state ${row.status}`);
    }
    this.runtime.storage.setInstanceStatus(this.id, "paused");
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
      this.runtime.storage.beginRollback(this.id);
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
