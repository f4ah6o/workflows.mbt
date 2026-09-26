import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowBinding, WorkflowInstanceHandle } from "./binding.mjs";
import { loadProjectConfig } from "./config.mjs";
import { parseDuration, parseSleepUntil } from "./duration.mjs";
import { loadKernel } from "./kernel.mjs";
import { bundleWorkflow, loadWorkflowModule } from "./loader.mjs";
import {
  decodeDurableValue,
  deserializeError,
  encodeDurableValue,
  observableConfig,
  serializeError,
  serializeJson,
} from "./serialization.mjs";
import { SQLiteStorage } from "./storage/sqlite.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class SuspendExecution extends Error {
  constructor(reason) {
    super(reason);
    this.name = "WorkflowsMbtSuspendExecution";
  }
}

class WaitForEventTimeoutError extends Error {
  constructor(name, type) {
    super(`waitForEvent step "${name}" timed out waiting for event type "${type}"`);
    this.name = "WorkflowWaitForEventTimeoutError";
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTimeout(valuePromise, timeoutMs) {
  if (timeoutMs == null) return await valuePromise;
  let timer;
  try {
    return await Promise.race([
      valuePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Workflow step attempt timed out after ${timeoutMs}ms`);
          error.name = "WorkflowStepTimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class WorkflowRuntime {
  static async open({
    configPath = "wrangler.jsonc",
    storagePath,
    buildDir,
    env = {},
    kernelPath = resolve(packageRoot, "dist/workflows_core.mjs"),
  } = {}) {
    const config = loadProjectConfig(configPath, { storagePath, buildDir });
    const kernel = await loadKernel(kernelPath);
    const storage = new SQLiteStorage(config.storagePath);
    const runtime = new WorkflowRuntime({ config, kernel, storage, env });
    await runtime.prepare();
    return runtime;
  }

  constructor({ config, kernel, storage, env }) {
    this.config = config;
    this.kernel = kernel;
    this.storage = storage;
    this.userEnv = env;
    this.workflowModule = null;
    this.workflowByName = new Map(config.workflows.map((w) => [w.name, w]));
  }

  async prepare() {
    for (const workflow of this.config.workflows) {
      if (!workflow.name || !workflow.binding || !workflow.className) {
        throw new Error("Each workflows[] entry requires name, binding, and class_name");
      }
      this.storage.registerWorkflow({ ...workflow, main: this.config.main });
    }
    this.bundlePath = await bundleWorkflow(this.config);
    this.workflowModule = await loadWorkflowModule(this.bundlePath);
    for (const workflow of this.config.workflows) {
      if (typeof this.workflowModule[workflow.className] !== "function") {
        throw new Error(
          `Workflow class ${workflow.className} is not exported by ${this.config.main}`,
        );
      }
    }
  }

  env() {
    const env = { ...this.userEnv };
    for (const workflow of this.config.workflows) {
      env[workflow.binding] = new WorkflowBinding(this, workflow);
    }
    return env;
  }

  requireInstance(id) {
    const row = this.storage.getInstance(id);
    if (!row) throw new Error(`Workflow instance not found: ${id}`);
    return row;
  }

  async createInstance(workflowName, options = {}) {
    if (!this.workflowByName.has(workflowName)) {
      throw new Error(`Unknown workflow: ${workflowName}`);
    }
    const id = options.id ?? randomUUID();
    const payload = serializeJson(options.params ?? {}, "workflow params");
    this.storage.createInstance({ id, workflowName, payload });
    return new WorkflowInstanceHandle(this, id);
  }

  async trigger(workflowName, options = {}, { run = true } = {}) {
    const instance = await this.createInstance(workflowName, options);
    if (run) await this.runPending();
    return instance;
  }

  instanceStatus(id) {
    const row = this.requireInstance(id);
    return {
      id: row.id,
      workflowName: row.workflow_name,
      status: row.status,
      output: row.output == null ? undefined : decodeDurableValue(row.output),
      error: row.error == null ? undefined : JSON.parse(row.error),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async sendEvent(id, event) {
    this.requireInstance(id);
    if (!event || typeof event.type !== "string") {
      throw new TypeError("sendEvent requires { type, payload }");
    }
    if (event.type.length < 1 || event.type.length > 100 || !/^[A-Za-z0-9_-]+$/.test(event.type)) {
      throw new TypeError(
        "event type must be 1..100 characters using letters, digits, '-' or '_'",
      );
    }
    const payload = serializeJson(event.payload ?? null, "event payload");
    this.storage.addEvent(id, event.type, payload);
  }

  async runPending({ maxRounds = 100 } = {}) {
    let ran = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const runnable = this.storage.listRunnable(Date.now());
      if (!runnable.length) break;
      for (const row of runnable) {
        await this.runInstance(row.id);
        ran += 1;
      }
    }
    return ran;
  }

  async runInstance(id) {
    let row = this.requireInstance(id);
    if (!this.kernel.canExecuteInstance(row.status)) return;
    if (["paused", "terminated", "complete", "errored", "rollingBack"].includes(row.status)) {
      return;
    }

    const workflow = this.workflowByName.get(row.workflow_name);
    if (!workflow) throw new Error(`Workflow registration disappeared: ${row.workflow_name}`);
    const WorkflowClass = this.workflowModule[workflow.className];
    const execution = new ExecutionContext(this, row);
    const instance = new WorkflowClass({}, this.env());
    const event = Object.freeze({
      payload: Object.freeze(JSON.parse(row.payload)),
      timestamp: new Date(row.created_at),
      instanceId: row.id,
      workflowName: row.workflow_name,
    });

    this.storage.setInstanceStatus(id, "running", { error: null });
    globalThis.__WORKFLOWS_MBT_CONTEXT__ = execution;
    try {
      const result = await instance.run(event, execution.stepFacade);
      const encoded = encodeDurableValue(result, "workflow output");
      this.storage.setInstanceStatus(id, "complete", { output: encoded, error: null });
    } catch (error) {
      if (error instanceof SuspendExecution) {
        row = this.requireInstance(id);
        if (!["paused", "terminated"].includes(row.status)) {
          this.storage.setInstanceStatus(id, "waiting");
        }
      } else {
        this.storage.setInstanceStatus(id, "errored", {
          error: serializeError(error),
        });
      }
    } finally {
      delete globalThis.__WORKFLOWS_MBT_CONTEXT__;
    }
  }

  async dev({ pollMs = 100, signal } = {}) {
    while (!signal?.aborted) {
      await this.runPending();
      await sleep(pollMs);
    }
  }

  close() {
    this.storage.close();
  }
}

class ExecutionContext {
  constructor(runtime, instance) {
    this.runtime = runtime;
    this.storage = runtime.storage;
    this.kernel = runtime.kernel;
    this.instance = instance;
    this.counts = new Map();
    this.ordinal = 0;
    this.operationInFlight = false;
    this.stepFacade = {
      do: (...args) => this.runExclusive("step.do", () => this.stepDo(...args)),
      sleep: (...args) => this.runExclusive("step.sleep", () => this.sleep(...args)),
      sleepUntil: (...args) =>
        this.runExclusive("step.sleepUntil", () => this.sleepUntil(...args)),
      waitForEvent: (...args) =>
        this.runExclusive("step.waitForEvent", () => this.waitForEvent(...args)),
    };
  }

  async runExclusive(label, operation) {
    if (this.operationInFlight) {
      const error = new Error(
        `Concurrent durable step operation ${label} is unsupported in workflows.mbt v0.1`,
      );
      error.name = "WorkflowsMbtParallelUnsupportedError";
      throw error;
    }
    this.operationInFlight = true;
    try {
      return await operation();
    } finally {
      this.operationInFlight = false;
    }
  }

  nextIdentity(type, name) {
    if (typeof name !== "string" || !name.length) {
      throw new TypeError("Workflow step name must be a non-empty string");
    }
    const counterKey = `${type}\u0000${name}`;
    const count = (this.counts.get(counterKey) ?? 0) + 1;
    this.counts.set(counterKey, count);
    this.ordinal += 1;
    return {
      instanceId: this.instance.id,
      type,
      name,
      count,
      key: this.kernel.stepKey(this.instance.id, type, name, count),
      ordinal: this.ordinal,
    };
  }

  normalizedConfig(config = {}) {
    const retries = config.retries ?? {};
    return {
      ...config,
      retries: {
        limit: retries.limit ?? this.kernel.defaultRetryLimit(),
        delay: retries.delay ?? this.kernel.defaultRetryDelayMs(),
        backoff: retries.backoff ?? this.kernel.defaultBackoff(),
      },
    };
  }

  async stepDo(name, config, callback) {
    const identity = this.nextIdentity("do", name);
    let step = this.storage.getStep(identity);
    if (step && this.kernel.shouldReplayOutput(step.state)) {
      return decodeDurableValue(step.output);
    }
    if (step?.state === "failed") throw deserializeError(step.error);

    const normalized = this.normalizedConfig(config);
    if (!Number.isInteger(normalized.retries.limit) || normalized.retries.limit < 0) {
      throw new TypeError("retries.limit must be a non-negative integer");
    }

    step = this.storage.ensureStep(
      identity, identity.ordinal, step?.state ?? "running", observableConfig(normalized),
    );

    if (step.state === "waiting_retry") {
      const timer = this.storage.getTimer(identity, "retry");
      if (timer && !this.kernel.deadlineReady(Date.now(), timer.wake_at)) {
        throw new SuspendExecution("retry-delay");
      }
    }

    const attempt = this.storage.countAttempts(identity) + 1;
    this.storage.updateStep(identity, { state: "running", error: null });
    this.storage.startAttempt(identity, attempt);
    const stepContext = {
      step: { name, count: identity.count },
      attempt,
      config: normalized,
    };

    try {
      const timeoutMs =
        normalized.timeout == null ? null : parseDuration(normalized.timeout, "step timeout");
      const result = await withTimeout(
        Promise.resolve().then(() => callback(stepContext)),
        timeoutMs,
      );
      const encoded = encodeDurableValue(result, `step "${name}" output`);
      this.storage.completeDoStep(identity, attempt, encoded);
      return result;
    } catch (error) {
      const encodedError = serializeError(error);
      const terminal =
        Boolean(error?.nonRetryable || error?.name === "NonRetryableError") ||
        attempt > normalized.retries.limit;
      if (terminal) {
        this.storage.finishDoStepTerminal(identity, attempt, encodedError);
        throw error;
      }

      let delayMs;
      if (typeof normalized.retries.delay === "function") {
        const dynamic = await normalized.retries.delay({ ctx: stepContext, error });
        delayMs = parseDuration(dynamic, "retry delay");
      } else {
        const base = parseDuration(normalized.retries.delay, "retry delay");
        if (base > 2_000_000_000) {
          throw new RangeError(
            "Static retry delay above 2,000,000,000ms is not yet supported by the MoonBit v0.1 kernel",
          );
        }
        delayMs = this.kernel.retryDelayMs(
          Math.trunc(base), attempt, normalized.retries.backoff,
        );
      }
      const wakeAt = Date.now() + delayMs;
      this.storage.scheduleRetry(identity, attempt, encodedError, wakeAt);
      throw new SuspendExecution("retry-delay");
    }
  }

  async sleep(name, duration) {
    const identity = this.nextIdentity("sleep", name);
    const existing = this.storage.getStep(identity);
    if (existing?.state === "completed") return;

    const waitMs = parseDuration(duration, "sleep duration");
    const initialWakeAt = Date.now() + waitMs;
    const { step, timer } = this.storage.waitOnTimer(
      identity,
      identity.ordinal,
      JSON.stringify({ mode: "relative", duration }),
      "sleep",
      initialWakeAt,
    );
    if (step.state === "completed") return;
    if (this.kernel.deadlineReady(Date.now(), timer.wake_at)) {
      this.storage.completeTimerStep(identity, "sleep");
      return;
    }
    throw new SuspendExecution("sleep");
  }

  async sleepUntil(name, timestamp) {
    const identity = this.nextIdentity("sleep", name);
    const existing = this.storage.getStep(identity);
    if (existing?.state === "completed") return;

    const wakeAt = parseSleepUntil(timestamp);
    const { step, timer } = this.storage.waitOnTimer(
      identity,
      identity.ordinal,
      JSON.stringify({ mode: "absolute", wakeAt }),
      "sleep",
      wakeAt,
    );
    if (step.state === "completed") return;
    if (this.kernel.deadlineReady(Date.now(), timer.wake_at)) {
      this.storage.completeTimerStep(identity, "sleep");
      return;
    }
    throw new SuspendExecution("sleepUntil");
  }

  async waitForEvent(name, options) {
    if (!options || typeof options.type !== "string") {
      throw new TypeError("waitForEvent requires { type, timeout? }");
    }
    if (
      options.type.length < 1 ||
      options.type.length > 100 ||
      !/^[A-Za-z0-9_-]+$/.test(options.type)
    ) {
      throw new TypeError(
        "waitForEvent type must be 1..100 characters using letters, digits, '-' or '_'",
      );
    }

    const identity = this.nextIdentity("waitForEvent", name);
    const existing = this.storage.getStep(identity);
    if (existing?.state === "completed") return decodeDurableValue(existing.output);
    if (existing?.state === "failed") throw deserializeError(existing.error);

    const timeoutMs = parseDuration(
      options.timeout ?? this.kernel.defaultWaitTimeoutMs(),
      "waitForEvent timeout",
    );
    const currentTimer = this.storage.getTimer(identity, "event-timeout");
    const wakeAt = currentTimer?.wake_at ?? Date.now() + timeoutMs;
    const decision = this.storage.waitForEvent(
      identity,
      identity.ordinal,
      JSON.stringify({ type: options.type, timeout: options.timeout ?? "24 hours" }),
      options.type,
      wakeAt,
      (event) =>
        encodeDurableValue(
          {
            type: event.type,
            payload: JSON.parse(event.payload),
            timestamp: new Date(event.created_at).toISOString(),
          },
          `event "${options.type}"`,
        ),
    );

    if (decision.event) {
      const step = this.storage.getStep(identity);
      const value = decodeDurableValue(step.output);
      return { ...value, timestamp: new Date(value.timestamp) };
    }

    if (decision.timer && this.kernel.deadlineReady(Date.now(), decision.timer.wake_at)) {
      const error = new WaitForEventTimeoutError(name, options.type);
      this.storage.timeoutEventStep(identity, serializeError(error));
      throw error;
    }
    throw new SuspendExecution("waitForEvent");
  }
}
