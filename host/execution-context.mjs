// Local implementation of the Cloudflare `ExecutionContext` surface that
// `cloudflare:workers` exposes to Worker fetch handlers and
// `WorkflowEntrypoint` instances (`this.ctx`).

export class AbortedError extends Error {
  constructor(reason) {
    super(reason instanceof Error ? reason.message : String(reason ?? "Invocation aborted"));
    this.name = "AbortedError";
    this.reason = reason;
  }
}

class LocalSpan {
  constructor(name) {
    this.name = name;
    this.isTraced = false;
  }

  setAttribute() {
    return this;
  }

  setAttributes() {
    return this;
  }

  recordException() {}

  updateName(name) {
    this.name = name;
    return this;
  }

  setStatus() {
    return this;
  }

  end() {}
}

function createTracing() {
  let activeSpan;
  return {
    Span: LocalSpan,
    enterSpan(name, callback, ...args) {
      return callback(new LocalSpan(name), ...args);
    },
    startActiveSpan(name, callback, ...args) {
      const span = new LocalSpan(name);
      const previous = activeSpan;
      activeSpan = span;
      try {
        return callback(span, ...args);
      } finally {
        activeSpan = previous;
      }
    },
    startSpan(name) {
      return new LocalSpan(name);
    },
    getActiveSpan() {
      return activeSpan;
    },
  };
}

export class WorkerExecutionContext {
  #onAbort;

  constructor(runtime, { props = {}, exports = {}, onAbort } = {}) {
    this.runtime = runtime;
    this.props = props;
    this.exports = exports;
    this.tracing = createTracing();
    this.cache = undefined;
    this.access = undefined;
    this.#onAbort = onAbort;
  }

  waitUntil(promise) {
    this.runtime.trackBackgroundTask(promise);
  }

  passThroughOnException() {}

  abort(reason) {
    this.#onAbort?.();
    throw new AbortedError(reason);
  }
}
