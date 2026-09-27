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

// Span lifecycle bookkeeping: `enterSpan` AUTO_ENDs its span and
// `startActiveSpan` is MANUAL_END. Upstream (workerd) performs this ending
// natively — it never calls the JS-visible `span.end()` method (verified via
// the differential probe), so ending here also bypasses the public method to
// stay unobservable for callers that patch or subclass `end()`.
const finishedSpans = new WeakSet();

function finishSpan(span) {
  finishedSpans.add(span);
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

  end() {
    finishSpan(this);
  }
}

function createTracing() {
  const spanStore = new AsyncLocalStorage();
  // workerd keeps the active span in the invocation's async context, so it is
  // still the active span after an `await` inside the callback.
  const runWithSpan = (name, callback, args, autoEnd) => {
    const span = new LocalSpan(name);
    const result = spanStore.run(span, () => callback(span, ...args));
    if (autoEnd) {
      if (result != null && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => finishSpan(span));
      }
      finishSpan(span);
    }
    return result;
  };
  return {
    Span: LocalSpan,
    enterSpan(name, callback, ...args) {
      return runWithSpan(name, callback, args, true);
    },
    startActiveSpan(name, callback, ...args) {
      return runWithSpan(name, callback, args, false);
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
