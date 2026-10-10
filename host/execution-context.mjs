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

// The pinned cf/Vite oracle has no ambient span in WorkflowEntrypoint.run;
// the October 2026 oracle has a stable invocation span. Both use the same
// Workers compatibility date, so changing compatibility_date cannot choose
// between these behaviors. Keep the pinned behavior by default and make the
// newer behavior an explicit local compatibility setting, never a test-only
// environment override or a normalization of the upstream result.
export function resolveTracingScope(scope = "callback") {
  if (scope !== "callback" && scope !== "invocation") {
    throw new TypeError('compatibility.tracingScope must be "callback" or "invocation"');
  }
  return scope;
}

function createTracing(scope) {
  const spanStore = new AsyncLocalStorage();
  const invocationSpan = scope === "invocation" ? new LocalSpan() : undefined;
  // workerd keeps the active span in the invocation's async context, so it is
  // still the active span after an `await` inside the callback.
  const runWithSpan = (name, callback, args, autoEnd) => {
    const span = new LocalSpan(name);
    try {
      const result = spanStore.run(span, () => callback(span, ...args));
      if (autoEnd) {
        if (result != null && typeof result.then === "function") {
          return Promise.resolve(result).finally(() => finishSpan(span));
        }
        finishSpan(span);
      }
      return result;
    } catch (error) {
      if (autoEnd) finishSpan(span);
      throw error;
    }
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
      return spanStore.getStore() ?? invocationSpan;
    },
  };
}

export class WorkerExecutionContext {
  #onAbort;

  constructor(runtime, { props = {}, exports = {}, onAbort } = {}) {
    this.runtime = runtime;
    this.props = props;
    this.exports = exports;
    this.tracing = createTracing(resolveTracingScope(runtime.config?.tracingScope));
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
