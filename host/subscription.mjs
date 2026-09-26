import { decodeDurableValue } from "./serialization.mjs";

const TERMINAL = new Set([
  "workflow_completed",
  "workflow_errored",
  "workflow_terminated",
]);

function parseDetail(text) {
  if (text == null) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function mapEvent(row) {
  const base = {
    instanceId: row.instance_id,
    eventId: row.id,
    timestamp: row.created_at,
  };
  const detail = parseDetail(row.detail);
  switch (row.kind) {
    case "instance.created":
      return { ...base, type: "workflow_queued" };
    case "instance.running":
      return { ...base, type: "workflow_running" };
    case "instance.paused":
      return { ...base, type: "workflow_paused" };
    case "instance.waitingForPause":
      return { ...base, type: "workflow_waiting_for_pause" };
    case "instance.waiting":
      return { ...base, type: "workflow_waiting" };
    case "instance.complete":
      return {
        ...base,
        type: "workflow_completed",
        ...(detail.output == null ? {} : { output: decodeDurableValue(detail.output) }),
      };
    case "instance.errored":
      return {
        ...base,
        type: "workflow_errored",
        error: detail.error == null
          ? { name: "Error", message: "Workflow errored" }
          : (() => {
              const error = JSON.parse(detail.error);
              return { name: error.name, message: error.message };
            })(),
      };
    case "instance.terminated":
      return { ...base, type: "workflow_terminated" };
    case "instance.rollback.started":
      return { ...base, type: "rollback_started" };
    case "rollback.attempt.started":
      return {
        ...base,
        type: "rollback_attempt_started",
        stepName: detail.name,
        attempt: detail.attempt,
      };
    case "rollback.completed":
      return {
        ...base,
        type: "rollback_step_completed",
        stepName: detail.name,
      };
    case "rollback.failed": {
      return {
        ...base,
        type: "rollback_step_errored",
        stepName: detail.name,
        error: { name: "Error", message: "Rollback step failed" },
      };
    }
    case "instance.rollback.complete":
      return { ...base, type: "rollback_completed" };
    case "instance.rollback.failed":
      return { ...base, type: "rollback_errored" };
    default:
      return null;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WorkflowSubscription {
  constructor(runtime, instanceId, { cursor = 0, filter } = {}) {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new TypeError("subscribe cursor must be a non-negative integer");
    }
    if (
      filter != null &&
      (!Array.isArray(filter) || filter.some((value) => typeof value !== "string"))
    ) {
      throw new TypeError("subscribe filter must be an array of event type strings");
    }
    this.runtime = runtime;
    this.instanceId = instanceId;
    this.cursor = cursor;
    this.filter = filter == null ? null : new Set(filter);
    this.disposed = false;
    this.done = false;
    this.inFlight = false;
  }

  [Symbol.dispose]() {
    this.disposed = true;
  }

  async next() {
    if (this.disposed || this.done) return { value: undefined, done: true };
    if (this.inFlight) {
      throw new Error("Workflow subscription supports one in-flight next() call");
    }
    this.inFlight = true;
    try {
      while (!this.disposed && !this.done) {
        const rows = this.runtime.storage.listExecutionEvents(
          this.instanceId,
          this.cursor,
          100,
        );
        for (const row of rows) {
          this.cursor = row.id;
          const event = mapEvent(row);
          if (!event) continue;
          const terminal = TERMINAL.has(event.type);
          const included = this.filter == null || this.filter.has(event.type);
          if (terminal) this.done = true;
          if (included) return { value: event, done: false };
          if (terminal) return { value: undefined, done: true };
        }

        const instance = this.runtime.requireInstance(this.instanceId);
        if (["complete", "errored", "terminated"].includes(instance.status)) {
          this.done = true;
          return { value: undefined, done: true };
        }
        await delay(25);
      }
      return { value: undefined, done: true };
    } finally {
      this.inFlight = false;
    }
  }
}
