import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowBinding, WorkflowInstanceHandle } from "./binding.mjs";
import { loadProjectConfig } from "./config.mjs";
import { matchesCron } from "./cron.mjs";
import { parseDuration, parseSleepUntil } from "./duration.mjs";
import {
  WorkflowInstanceDeletedExecution,
  workflowExecutionScope,
} from "./execution-scope.mjs";
import { WorkerExecutionContext } from "./execution-context.mjs";
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
    this.backgroundTasks = new Set();
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
    const env = {
      ...this.config.vars,
      ...this.config.localDevEnv,
      ...this.userEnv,
    };
    for (const workflow of this.config.workflows) {
      env[workflow.binding] = new WorkflowBinding(this, workflow);
    }
    return env;
  }

  requireStoredInstance(storageId) {
    this.storage.deleteExpired(Date.now());
    const row = this.storage.getInstance(storageId);
    if (!row) throw new Error(`Workflow instance not found: ${storageId}`);
    return row;
  }

  getStoredInstance(storageId) {
    this.storage.deleteExpired(Date.now());
    return this.storage.getInstance(storageId);
  }

  requireInstance(id, workflowName = null) {
    this.storage.deleteExpired(Date.now());
    if (workflowName != null) {
      const row = this.storage.getInstanceByPublic(workflowName, id);
      if (!row) throw new Error(`Workflow instance not found: ${id}`);
      return row;
    }
    const rows = this.storage.findInstancesByPublic(id);
    if (rows.length === 0) throw new Error(`Workflow instance not found: ${id}`);
    if (rows.length > 1) {
      throw new Error(
        `Workflow instance id is ambiguous across workflows: ${id}`,
      );
    }
    return rows[0];
  }

  async createInstance(workflowName, options = {}) {
    if (!this.workflowByName.has(workflowName)) {
      throw new Error(`Unknown workflow: ${workflowName}`);
    }
    const workflow = this.workflowByName.get(workflowName);
    const id = options.id ?? randomUUID();
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 100 ||
      /^cf_[0-9a-f]{64}$/i.test(id)
    ) {
      throw new TypeError("Workflow instance id must be 1..100 characters and not use the reserved cf_<sha256> namespace");
    }
    const payload = serializeJson(options.params ?? {}, "workflow params");
    const retention = this.resolveRetention(workflow, options.retention ?? {});
    this.storage.createInstance({ id, workflowName, payload, retention });
    return new WorkflowInstanceHandle(this, workflowName, id);
  }

  resolveRetention(workflow, requestedRetention = {}) {
    const defaultRetention = workflow.defaultRetention ?? {};
    const successRetention =
      requestedRetention.successRetention ??
      requestedRetention.success_retention ??
      defaultRetention.success_retention;
    const errorRetention =
      requestedRetention.errorRetention ??
      requestedRetention.error_retention ??
      defaultRetention.error_retention;
    return {
      successRetentionMs: successRetention == null
        ? null
        : parseDuration(successRetention, "success retention"),
      errorRetentionMs: errorRetention == null
        ? null
        : parseDuration(errorRetention, "error retention"),
    };
  }

  async trigger(workflowName, options = {}, { run = true } = {}) {
    const instance = await this.createInstance(workflowName, options);
    if (run) await this.runPending();
    return instance;
  }

  instanceStatus(id, workflowName = null) {
    const row = this.requireInstance(id, workflowName);
    return {
      id: row.public_id,
      workflowName: row.workflow_name,
      status: row.status === "rollingBack" ? "running" : row.status,
      output: row.output == null ? undefined : decodeDurableValue(row.output),
      error: row.error == null ? undefined : JSON.parse(row.error),
      rollback: row.rollback_outcome == null
        ? null
        : {
            outcome: row.rollback_outcome,
            error: row.rollback_error == null ? undefined : JSON.parse(row.rollback_error),
          },
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  workflowEvent(row) {
    const event = {
      payload: Object.freeze(JSON.parse(row.payload)),
      timestamp: new Date(row.created_at),
      instanceId: row.public_id,
      workflowName: row.workflow_name,
    };
    if (row.schedule_cron != null && row.scheduled_time != null) {
      event.schedule = Object.freeze({
        cron: row.schedule_cron,
        scheduledTime: row.scheduled_time,
      });
    }
    return Object.freeze(event);
  }

  scheduledInstanceId(workflowName, cron, scheduledTime) {
    const digest = createHash("sha256")
      .update(`${workflowName}\u0000${cron}\u0000${scheduledTime}`)
      .digest("hex");
    return `cf_${digest}`;
  }

  async enqueueSchedules(now = Date.now()) {
    const currentMinute = Math.floor(now / 60_000) * 60_000;
    const maxCatchup = currentMinute - 7 * 24 * 60 * 60 * 1000;
    let created = 0;

    for (const workflow of this.config.workflows) {
      for (const cron of workflow.schedules ?? []) {
        let cursor = this.storage.getScheduleCursor(workflow.name, cron);
        if (cursor == null) cursor = currentMinute - 60_000;
        cursor = Math.max(cursor, maxCatchup);

        for (
          let scheduledTime = cursor + 60_000;
          scheduledTime <= currentMinute;
          scheduledTime += 60_000
        ) {
          if (!matchesCron(cron, scheduledTime)) continue;
          const id = this.scheduledInstanceId(workflow.name, cron, scheduledTime);
          const result = this.storage.claimScheduledInstance({
            id,
            workflowName: workflow.name,
            payload: serializeJson({}, "scheduled workflow params"),
            cron,
            scheduledTime,
            retention: this.resolveRetention(workflow),
          });
          if (result.created) created += 1;
        }
        this.storage.setScheduleCursor(workflow.name, cron, currentMinute);
      }
    }
    return created;
  }

  async sendEvent(id, event, workflowName = null) {
    const instance = this.requireInstance(id, workflowName);
    if (!["queued", "running", "waiting", "waitingForPause"].includes(instance.status)) {
      throw new Error(`Cannot send event to instance in state ${instance.status}`);
    }
    if (!event || typeof event.type !== "string") {
      throw new TypeError("sendEvent requires { type, payload }");
    }
    if (event.type.length < 1 || event.type.length > 100 || !/^[A-Za-z0-9_-]+$/.test(event.type)) {
      throw new TypeError(
        "event type must be 1..100 characters using letters, digits, '-' or '_'",
      );
    }
    const payload = serializeJson(event.payload ?? null, "event payload");
    this.storage.addEvent(instance.id, event.type, payload);
  }

  async runPending({ maxRounds = 100 } = {}) {
    this.storage.deleteExpired(Date.now());
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
    let row = this.getStoredInstance(id);
    if (!row) return;
    if (row.status === "rollingBack") {
      await this.runRollbackInstance(id);
      return;
    }
    if (!this.kernel.canExecuteInstance(row.status)) return;
    if (["paused", "terminated", "complete", "errored"].includes(row.status)) {
      return;
    }

    const workflow = this.workflowByName.get(row.workflow_name);
    if (!workflow) throw new Error(`Workflow registration disappeared: ${row.workflow_name}`);
    const WorkflowClass = this.workflowModule[workflow.className];
    const execution = new ExecutionContext(this, row);
    const instance = new WorkflowClass(this.workflowExecutionContext(id), this.env());
    const event = this.workflowEvent(row);

    this.storage.markInstanceStarted(id, JSON.parse(row.payload));
    this.storage.setInstanceStatus(id, "running", { error: null });
    globalThis.__WORKFLOWS_MBT_CONTEXT__ = execution;
    try {
      const result = await workflowExecutionScope.run(
        { instanceStorageId: id },
        () => instance.run(event, execution.stepFacade),
      );
      const pending = await execution.settleOperations();
      const suspension = pending.find(
        (settled) => settled.status === "rejected" && settled.reason instanceof SuspendExecution,
      );
      if (suspension) throw suspension.reason;
      row = this.getStoredInstance(id);
      if (!row) return;
      if (row.status === "waitingForPause") {
        this.storage.setInstanceStatus(id, "paused");
        return;
      }
      if (["paused", "terminated", "rollingBack"].includes(row.status)) {
        return;
      }
      const encoded = encodeDurableValue(result, "workflow output");
      this.storage.setInstanceStatus(id, "complete", { output: encoded, error: null });
    } catch (error) {
      await execution.settleOperations();
      row = this.getStoredInstance(id);
      if (!row || error instanceof WorkflowInstanceDeletedExecution) return;
      if (row.status === "waitingForPause") {
        this.storage.setInstanceStatus(id, "paused");
        return;
      }
      if (["paused", "terminated", "rollingBack"].includes(row.status)) {
        return;
      }
      if (error instanceof SuspendExecution) {
        this.storage.setInstanceStatus(id, "waiting");
      } else {
        const encodedError = serializeError(error);
        const rollbacks = this.storage.listRollbackRegistrations(id);
        if (rollbacks.length) {
          this.storage.setInstanceStatus(id, "running", { error: encodedError });
          this.storage.beginRollback(id, {
            terminalStatus: "errored",
            cause: encodedError,
          });
        } else {
          this.storage.setInstanceStatus(id, "errored", {
            error: encodedError,
          });
        }
      }
    } finally {
      delete globalThis.__WORKFLOWS_MBT_CONTEXT__;
    }
  }

  async runRollbackInstance(id) {
    const row = this.getStoredInstance(id);
    if (!row || row.status !== "rollingBack") return;

    const workflow = this.workflowByName.get(row.workflow_name);
    if (!workflow) throw new Error(`Workflow registration disappeared: ${row.workflow_name}`);
    const WorkflowClass = this.workflowModule[workflow.className];
    const execution = new ExecutionContext(this, row, { rollbackHydration: true });
    const instance = new WorkflowClass(this.workflowExecutionContext(id), this.env());
    const event = this.workflowEvent(row);

    globalThis.__WORKFLOWS_MBT_CONTEXT__ = execution;
    try {
      try {
        await workflowExecutionScope.run(
          { instanceStorageId: id },
          () => instance.run(event, execution.stepFacade),
        );
      } catch {
        // Forward execution is replayed only far enough to reconstruct rollback
        // closures. Its first unfinished/failed boundary is expected here.
      }
      await execution.settleOperations();
    } finally {
      delete globalThis.__WORKFLOWS_MBT_CONTEXT__;
    }

    const registrations = this.storage.listRollbackRegistrations(id);
    for (const registration of registrations) {
      if (registration.state === "completed") continue;
      if (registration.state === "failed") {
        this.storage.finishRollback(id, "failed", registration.rollback_error);
        return;
      }
      if (
        registration.state === "waiting_retry" &&
        registration.wake_at != null &&
        !this.kernel.deadlineReady(Date.now(), registration.wake_at)
      ) {
        return;
      }

      const identity = {
        instanceId: id,
        type: registration.step_type,
        name: registration.step_name,
        count: registration.step_count,
        key: this.kernel.stepKey(
          id, registration.step_type, registration.step_name, registration.step_count,
        ),
        ordinal: registration.ordinal,
      };
      const handler = execution.rollbackHandlers.get(identity.key);
      if (!handler) {
        const error = new Error(
          `Rollback handler could not be reconstructed for ${identity.type}/${identity.name}/${identity.count}`,
        );
        error.name = "WorkflowRollbackHandlerMissingError";
        const encodedError = serializeError(error);
        const attempt = Math.max(1, registration.attempt || 0);
        this.storage.failRollback(identity, attempt, encodedError);
        this.storage.finishRollback(id, "failed", encodedError);
        return;
      }

      const rollbackConfig = execution.normalizedConfig(handler.config ?? {});
      if (
        !Number.isInteger(rollbackConfig.retries.limit) ||
        rollbackConfig.retries.limit < 0 ||
        rollbackConfig.retries.limit > 10_000
      ) {
        const error = new TypeError(
          "rollback retries.limit must be an integer between 0 and 10000",
        );
        const encodedError = serializeError(error);
        this.storage.failRollback(identity, Math.max(1, registration.attempt || 0), encodedError);
        this.storage.finishRollback(id, "failed", encodedError);
        return;
      }

      const forwardStep = this.storage.getStep(identity);
      const forwardConfig = forwardStep?.config ? JSON.parse(forwardStep.config) : {};
      const rollbackContext = {
        ctx: {
          step: { name: identity.name, count: identity.count },
          attempt: Math.max(1, this.storage.countAttempts(identity)),
          config: forwardConfig,
        },
        error: row.rollback_cause == null
          ? undefined
          : deserializeError(row.rollback_cause),
        output: registration.output == null
          ? undefined
          : decodeDurableValue(registration.output),
      };
      const attempt =
        registration.state === "running" && registration.attempt > 0
          ? registration.attempt
          : registration.attempt + 1;
      this.storage.startRollbackAttempt(identity, attempt);

      try {
        const timeoutMs = rollbackConfig.timeout == null
          ? null
          : parseDuration(rollbackConfig.timeout, "rollback timeout");
        await workflowExecutionScope.run(
          { instanceStorageId: id },
          () => withTimeout(
            Promise.resolve().then(() => handler.rollback(rollbackContext)),
            timeoutMs,
          ),
        );
        if (!this.storage.getInstance(id)) return;
        this.storage.completeRollback(identity);
      } catch (error) {
        if (
          error instanceof WorkflowInstanceDeletedExecution ||
          !this.storage.getInstance(id)
        ) {
          return;
        }
        const encodedError = serializeError(error);
        const terminal =
          Boolean(error?.nonRetryable || error?.name === "NonRetryableError") ||
          attempt > rollbackConfig.retries.limit;
        if (terminal) {
          this.storage.failRollback(identity, attempt, encodedError);
          this.storage.finishRollback(id, "failed", encodedError);
          return;
        }

        let delayMs;
        if (typeof rollbackConfig.retries.delay === "function") {
          const dynamic = await rollbackConfig.retries.delay({
            ctx: rollbackContext.ctx,
            error,
          });
          delayMs = parseDuration(dynamic, "rollback retry delay");
        } else {
          const base = parseDuration(rollbackConfig.retries.delay, "rollback retry delay");
          if (base > 2_000_000_000) {
            const rangeError = new RangeError(
              "Static rollback retry delay above 2,000,000,000ms is not supported",
            );
            const rangeEncoded = serializeError(rangeError);
            this.storage.failRollback(identity, attempt, rangeEncoded);
            this.storage.finishRollback(id, "failed", rangeEncoded);
            return;
          }
          delayMs = this.kernel.retryDelayMs(
            Math.trunc(base), attempt, rollbackConfig.retries.backoff,
          );
        }
        this.storage.scheduleRollbackRetry(
          identity, attempt, encodedError, Date.now() + delayMs,
        );
        return;
      }
    }

    if (!this.storage.getInstance(id)) return;
    this.storage.finishRollback(id, "complete", null);
  }

  // Loopback-compatible entries for ctx.exports, mirroring workerd's
  // LoopbackForExport surface: `default` is a service stub whose methods are
  // invoked with env/ctx injected, and configured Workflow classes resolve to
  // Workflow bindings (see workflowExports).
  loopbackHandler(target) {
    const runtime = this;
    return new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop);
        if (typeof value !== "function") return value;
        if (prop === "fetch") {
          // Fetcher.fetch(input, init) — workerd normalizes input+init into a
          // Request before invoking the handler as (request, env, ctx).
          return (input, init) =>
            Reflect.apply(value, obj, [
              new Request(input, init),
              runtime.env(),
              runtime.workflowExecutionContext(),
            ]);
        }
        // Other handler members take their public arguments followed by the
        // injected (env, ctx) pair.
        return (...args) =>
          Reflect.apply(value, obj, [
            ...args,
            runtime.env(),
            runtime.workflowExecutionContext(),
          ]);
      },
    });
  }

  workflowExports() {
    const exports = {};
    const defaultExport = this.workflowModule?.default;
    if (defaultExport != null && ["object", "function"].includes(typeof defaultExport)) {
      exports.default = this.loopbackHandler(defaultExport);
    }
    // Configured Workflow classes are exposed as Workflow bindings under their
    // export names (workerd: "Server: configured Workflow is exposed through
    // ctx.exports"; upstream installs ctxExports via v8Set, i.e. ordinary
    // enumerable own properties). wrangler dev does not implement this — its
    // exports enumeration is a dev/oracle limitation documented in
    // COMPATIBILITY.md, not the target behavior.
    for (const workflow of this.config.workflows ?? []) {
      if (typeof this.workflowModule?.[workflow.className] === "function") {
        exports[workflow.className] = new WorkflowBinding(this, workflow);
      }
    }
    // Non-Workflow named entrypoints: ExportedHandler-shaped exports (objects
    // exposing handler members like fetch/scheduled/queue) become loopback
    // service stubs. WorkerEntrypoint/DurableObject class exports remain a
    // documented gap — the local runtime has no service-binding/actor backing
    // for them.
    for (const [name, value] of Object.entries(this.workflowModule ?? {})) {
      if (name === "default" || name in exports) continue;
      if (
        value != null &&
        typeof value === "object" &&
        Object.values(value).some((member) => typeof member === "function")
      ) {
        exports[name] = this.loopbackHandler(value);
      }
    }
    return exports;
  }

  workflowExecutionContext(instanceStorageId = null) {
    return new WorkerExecutionContext(this, {
      exports: this.workflowExports(),
      onAbort: instanceStorageId == null
        ? undefined
        : () => {
            const row = this.storage.getInstance(instanceStorageId);
            if (row && !["complete", "errored", "terminated"].includes(row.status)) {
              this.storage.setInstanceStatus(instanceStorageId, "terminated");
            }
          },
    });
  }

  trackBackgroundTask(promise) {
    const task = Promise.resolve(promise);
    this.backgroundTasks.add(task);
    task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    );
    return task;
  }

  async fetch(request) {
    const exported = this.workflowModule?.default;
    const handler =
      typeof exported === "function"
        ? exported
        : exported && typeof exported.fetch === "function"
          ? exported.fetch.bind(exported)
          : null;
    if (!handler) {
      return new Response("No default Worker fetch handler is exported", { status: 404 });
    }

    const response = await handler(request, this.env(), this.workflowExecutionContext());
    if (!(response instanceof Response)) {
      throw new TypeError("Default Worker fetch handler must return a Response");
    }
    return response;
  }

  async dev({ pollMs = 100, signal } = {}) {
    while (!signal?.aborted) {
      await this.enqueueSchedules();
      await this.runPending();
      await sleep(pollMs);
    }
  }

  // Drains pending ctx.waitUntil() tasks before closing storage so delayed
  // continuations still observe a live runtime. Resolves synchronously when
  // no tasks are pending, so bare close() callers keep old behavior.
  async close() {
    while (this.backgroundTasks.size) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    this.storage.close();
  }
}

class ExecutionContext {
  constructor(runtime, instance, { rollbackHydration = false } = {}) {
    this.runtime = runtime;
    this.storage = runtime.storage;
    this.kernel = runtime.kernel;
    this.instance = instance;
    this.rollbackHydration = rollbackHydration;
    this.rollbackHandlers = new Map();
    this.counts = new Map();
    this.ordinal = 0;
    this.pendingOperations = new Set();
    this.suspensions = [];
    this.stepFacade = {
      do: (name, first, second, third) =>
        this.trackOperation(this.compatStepDo(name, first, second, third)),
      sleep: (...args) => this.trackOperation(this.sleep(...args)),
      sleepUntil: (...args) => this.trackOperation(this.sleepUntil(...args)),
      waitForEvent: (...args) => this.trackOperation(this.waitForEvent(...args)),
    };
  }

  checkLifecycleBoundary() {
    if (this.rollbackHydration) return;
    const row = this.storage.getInstance(this.instance.id);
    if (!row) throw new SuspendExecution("instance-deleted");
    if (row.status === "waitingForPause") {
      this.storage.setInstanceStatus(this.instance.id, "paused");
      throw new SuspendExecution("pause-boundary");
    }
    if (["paused", "terminated", "rollingBack"].includes(row.status)) {
      throw new SuspendExecution("lifecycle-boundary");
    }
  }

  async compatStepDo(name, first, second, third) {
    this.checkLifecycleBoundary();
    let config = {};
    let callback;
    let rollbackOptions;

    if (typeof first === "function") {
      callback = first;
      rollbackOptions = second;
    } else {
      config = first ?? {};
      callback = second;
      rollbackOptions = third;
    }

    if (typeof callback !== "function") {
      throw new TypeError("step.do requires a callback");
    }
    if (rollbackOptions != null && typeof rollbackOptions !== "object") {
      throw new TypeError("step.do rollback options must be an object");
    }
    if (
      rollbackOptions?.rollback != null &&
      typeof rollbackOptions.rollback !== "function"
    ) {
      throw new TypeError("step.do rollback must be a function");
    }

    return await this.stepDo(name, config, callback, rollbackOptions ?? null);
  }

  trackOperation(operation) {
    const promise = Promise.resolve(operation);
    this.pendingOperations.add(promise);
    promise.then(
      () => this.pendingOperations.delete(promise),
      (error) => {
        if (error instanceof SuspendExecution) this.suspensions.push(error);
        this.pendingOperations.delete(promise);
      },
    );
    return promise;
  }

  async settleOperations() {
    const settled = [];
    while (this.pendingOperations.size) {
      const batch = [...this.pendingOperations];
      settled.push(...await Promise.allSettled(batch));
    }
    settled.push(
      ...this.suspensions.map((reason) => ({ status: "rejected", reason })),
    );
    return settled;
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

  adoptPersistedOrdinal(identity, step) {
    if (!step) return identity;
    identity.ordinal = step.ordinal;
    this.ordinal = Math.max(this.ordinal, step.ordinal);
    return identity;
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
      timeout: config.timeout ?? this.kernel.defaultStepTimeout(),
    };
  }

  async stepDo(name, config, callback, rollbackOptions = null) {
    const identity = this.nextIdentity("do", name);
    const rollback = rollbackOptions?.rollback
      ? {
          rollback: rollbackOptions.rollback,
          config: rollbackOptions.rollbackConfig ?? {},
        }
      : null;
    if (rollback) {
      this.rollbackHandlers.set(identity.key, rollback);
    }

    let step = this.storage.getStep(identity);
    this.adoptPersistedOrdinal(identity, step);
    if (step && this.kernel.shouldReplayOutput(step.state)) {
      if (rollback && !this.rollbackHydration) {
        this.storage.registerRollback(
          identity,
          identity.ordinal,
          observableConfig(this.normalizedConfig(rollback.config)),
          step.output,
          null,
        );
      }
      return decodeDurableValue(step.output);
    }
    if (step?.state === "failed") {
      if (rollback && !this.rollbackHydration) {
        this.storage.registerRollback(
          identity,
          identity.ordinal,
          observableConfig(this.normalizedConfig(rollback.config)),
          null,
          step.error,
        );
      }
      throw deserializeError(step.error);
    }
    if (this.rollbackHydration) {
      throw new SuspendExecution("rollback-hydration-boundary");
    }

    const normalized = this.normalizedConfig(config);
    if (
      !Number.isInteger(normalized.retries.limit) ||
      normalized.retries.limit < 0 ||
      normalized.retries.limit > 10_000
    ) {
      throw new TypeError("retries.limit must be an integer between 0 and 10000");
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
      if (!this.storage.getInstance(this.instance.id)) {
        throw new WorkflowInstanceDeletedExecution(this.instance.id);
      }
      const encoded = encodeDurableValue(result, `step "${name}" output`);
      this.storage.completeDoStep(
        identity,
        attempt,
        encoded,
        rollback
          ? { config: observableConfig(this.normalizedConfig(rollback.config)) }
          : null,
      );
      return result;
    } catch (error) {
      if (
        error instanceof WorkflowInstanceDeletedExecution ||
        !this.storage.getInstance(this.instance.id)
      ) {
        throw new WorkflowInstanceDeletedExecution(this.instance.id);
      }
      const encodedError = serializeError(error);
      const terminal =
        Boolean(error?.nonRetryable || error?.name === "NonRetryableError") ||
        attempt > normalized.retries.limit;
      if (terminal) {
        this.storage.finishDoStepTerminal(
          identity,
          attempt,
          encodedError,
          rollback
            ? { config: observableConfig(this.normalizedConfig(rollback.config)) }
            : null,
        );
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
    this.checkLifecycleBoundary();
    const identity = this.nextIdentity("sleep", name);
    const existing = this.storage.getStep(identity);
    this.adoptPersistedOrdinal(identity, existing);
    if (existing?.state === "completed") return;
    if (this.rollbackHydration) {
      throw new SuspendExecution("rollback-hydration-boundary");
    }

    const waitMs = parseDuration(duration, "sleep duration");
    const initialWakeAt = Date.now() + waitMs;
    const { step, timer } = this.storage.waitOnTimer(
      identity,
      identity.ordinal,
      JSON.stringify({ mode: "relative", duration, durationMs: waitMs }),
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
    this.checkLifecycleBoundary();
    const identity = this.nextIdentity("sleep", name);
    const existing = this.storage.getStep(identity);
    this.adoptPersistedOrdinal(identity, existing);
    if (existing?.state === "completed") return;
    if (this.rollbackHydration) {
      throw new SuspendExecution("rollback-hydration-boundary");
    }

    const wakeAt = parseSleepUntil(timestamp);
    const { step, timer } = this.storage.waitOnTimer(
      identity,
      identity.ordinal,
      JSON.stringify({
        mode: "absolute",
        wakeAt,
        durationMs: Math.max(0, wakeAt - Date.now()),
      }),
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
    this.checkLifecycleBoundary();
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
    this.adoptPersistedOrdinal(identity, existing);
    if (existing?.state === "completed") return decodeDurableValue(existing.output);
    if (existing?.state === "failed") throw deserializeError(existing.error);
    if (this.rollbackHydration) {
      throw new SuspendExecution("rollback-hydration-boundary");
    }

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
