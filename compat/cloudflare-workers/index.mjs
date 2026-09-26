const context = () => {
  const value = globalThis.__WORKFLOWS_MBT_CONTEXT__;
  if (!value) throw new Error("Workflow API used outside a workflows.mbt execution");
  return value;
};

export class WorkflowEntrypoint {
  constructor(_ctx, env) {
    this.env = env ?? {};
  }

  async run(_event, _step) {
    throw new Error("WorkflowEntrypoint.run() must be implemented by the workflow");
  }
}

export class WorkflowStep {
  async do(name, first, second, third) {
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
    return await context().stepDo(name, config, callback, rollbackOptions ?? null);
  }

  async sleep(name, duration) {
    return await context().sleep(name, duration);
  }

  async sleepUntil(name, timestamp) {
    return await context().sleepUntil(name, timestamp);
  }

  async waitForEvent(name, options) {
    return await context().waitForEvent(name, options);
  }
}

export class NonRetryableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NonRetryableError";
    this.nonRetryable = true;
  }
}

export class UnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowsMbtUnsupportedError";
  }
}
