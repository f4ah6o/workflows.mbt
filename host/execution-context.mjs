// Local implementation of the Cloudflare `ExecutionContext` surface that
// `cloudflare:workers` exposes to Worker fetch handlers and
// `WorkflowEntrypoint` instances (`this.ctx`).

import { AsyncLocalStorage } from "node:async_hooks";

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
  const spanStore = new AsyncLocalStorage();
  // workerd keeps the active span in the invocation's async context, so it is
  // still the active span after an `await` inside the callback, and the span
  // ends when a returned Promise settles.
  const runWithSpan = (name, callback, args) => {
    const span = new LocalSpan(name);
    const result = spanStore.run(span, () => callback(span, ...args));
    if (result != null && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => span.end());
    }
    span.end();
    return result;
  };
  return {
    Span: LocalSpan,
    enterSpan(name, callback, ...args) {
      return runWithSpan(name, callback, args);
    },
    startActiveSpan(name, callback, ...args) {
      return runWithSpan(name, callback, args);
    },
    startSpan(name) {
      return new LocalSpan(name);
    },
    getActiveSpan() {
      return spanStore.getStore();
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
