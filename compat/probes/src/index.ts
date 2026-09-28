import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type Params = { probe: string; counterUrl?: string };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Module-scope marker used by the worker-http probe to verify that
// ctx.waitUntil() work outlives the HTTP response on both runtimes.
let waitUntilMarker = "unset";

export class OracleWorkflow extends WorkflowEntrypoint<{}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    switch (event.payload.probe) {
      case "basic": {
        const value = await step.do("answer", async () => 42);
        return { value };
      }
      case "retry": {
        return await step.do(
          "retry",
          { retries: { limit: 2, delay: 250, backoff: "constant" } },
          async (ctx) => {
            if (ctx.attempt === 1) throw new Error("retry-me");
            return { attempt: ctx.attempt };
          },
        );
      }
      case "sleep": {
        await step.sleep("short-sleep", 250);
        return { slept: true };
      }
      case "sleep-until": {
        await step.sleepUntil("until", new Date(Date.now() + 250));
        return { slept: true };
      }
      case "wait-for-event": {
        const received = await step.waitForEvent<{ value: number }>(
          "gate",
          { type: "go", timeout: "1 minute" },
        );
        return { type: received.type, payload: received.payload };
      }
      case "durable-with-event": {
        const [side, received] = await Promise.all([
          step.do("side", async () => "side-output"),
          step.waitForEvent<{ value: number }>("gate", {
            type: "go",
            timeout: "1 minute",
          }),
        ]);
        return { side, type: received.type, payload: received.payload };
      }
      case "wait-timeout": {
        try {
          await step.waitForEvent("never-arrives", {
            type: "never",
            timeout: 300,
          });
          return { timedOut: false };
        } catch (error) {
          return {
            timedOut: true,
            name: (error as Error).name,
            message: (error as Error).message,
          };
        }
      }
      case "promise-all": {
        const [a, b] = await Promise.all([
          step.do("branch-a", async () => "a"),
          step.do("branch-b", async () => "b"),
        ]);
        return { a, b };
      }
      case "promise-allsettled": {
        const settled = await Promise.allSettled([
          step.do("ok", async () => "fine"),
          step.do("fails", async () => {
            throw new NonRetryableError("settle-me");
          }),
        ]);
        return settled.map((item) =>
          item.status === "fulfilled"
            ? { status: "fulfilled", value: item.value }
            : {
                status: "rejected",
                name: (item.reason as Error).name,
                message: (item.reason as Error).message,
              },
        );
      }
      case "promise-race": {
        // The winner must be deterministic on both engines: race a durable
        // step against a plain non-durable timer so the durable branch always
        // wins. Bare durable-vs-durable races are not asserted (Cloudflare
        // itself does not guarantee a stable replay winner).
        const winner = await Promise.race([
          step.do("winner", async () => "fast"),
          delay(500).then(() => "slow"),
        ]);
        return { winner };
      }
      case "promise-any": {
        const winner = await Promise.any([
          step.do("rejected", async () => {
            throw new NonRetryableError("any-loser");
          }),
          step.do("accepted", async () => "chosen"),
        ]);
        return { winner };
      }
      case "retry-in-branch": {
        const [stable, flaky] = await Promise.all([
          step.do("stable", async () => "stable"),
          step.do(
            "flaky",
            { retries: { limit: 1, delay: 50, backoff: "constant" } },
            async (ctx) => {
              if (ctx.attempt === 1) throw new Error("flaky-branch");
              return { attempt: ctx.attempt };
            },
          ),
        ]);
        return { stable, flaky };
      }
      case "wrapped-race": {
        const winner = await step.do("wrapped", async () =>
          Promise.race([
            delay(20).then(() => "fast"),
            delay(500).then(() => "slow"),
          ]),
        );
        return { winner };
      }
      case "nonretryable": {
        try {
          await step.do("fatal", async () => {
            throw new NonRetryableError("no-retry");
          });
          return { caught: false };
        } catch (error) {
          return {
            caught: true,
            name: (error as Error).name,
            message: (error as Error).message,
          };
        }
      }
      case "duplicate-names": {
        const values = await Promise.all([
          step.do("dup", async () => "one"),
          step.do("dup", async () => "two"),
          step.do("dup", async () => "three"),
        ]);
        return { values };
      }
      case "step-context": {
        return await step.do(
          "inspect",
          { retries: { limit: 3, delay: 25, backoff: "linear" }, timeout: 5000 },
          async (ctx) => ({
            name: ctx.step.name,
            count: ctx.step.count,
            attempt: ctx.attempt,
            retries: ctx.config.retries ?? null,
            timeout: ctx.config.timeout ?? null,
          }),
        );
      }
      case "dynamic-delay": {
        return await step.do(
          "dynamic",
          {
            retries: {
              limit: 2,
              delay: () => 75,
            },
          },
          async (ctx) => {
            if (ctx.attempt === 1) throw new Error("dynamic-delay");
            return {
              attempt: ctx.attempt,
              hasDelay: Object.hasOwn(ctx.config.retries ?? {}, "delay"),
            };
          },
        );
      }
      case "sensitive": {
        await step.do("secret", { sensitive: "output" }, async () => "s3cr3t");
        return { visible: "to-workflow" };
      }
      case "ser-structured": {
        try {
          const revived = await step.do("structured", async () => ({
            date: new Date("2026-01-02T03:04:05.006Z"),
            regexp: /wor[kl]flows/gi,
            nested: { inner: { when: new Date("2020-02-29T00:00:00.000Z") } },
            undef: undefined,
            nan: NaN,
            inf: Infinity,
            ninf: -Infinity,
            negzero: -0,
          }));
          return {
            dateIsDate: revived.date instanceof Date,
            dateValue: revived.date instanceof Date ? revived.date.getTime() : -1,
            regexpIsRegExp: revived.regexp instanceof RegExp,
            regexpSource: revived.regexp instanceof RegExp ? revived.regexp.source : "",
            regexpFlags: revived.regexp instanceof RegExp ? revived.regexp.flags : "",
            nestedDateIsDate: revived.nested.inner.when instanceof Date,
            undefIsUndefined: revived.undef === undefined && "undef" in revived,
            nanIsNaN: Number.isNaN(revived.nan),
            infIsInf: revived.inf === Infinity,
            ninfIsNInf: revived.ninf === -Infinity,
            negZero: Object.is(revived.negzero, -0),
          };
        } catch (error) {
          return { rejected: true, name: (error as Error).name };
        }
      }
      case "ser-bigint": {
        try {
          const revived = await step.do("bigint", async () => ({
            value: 9007199254740993n,
          }));
          return {
            rejected: false,
            bigintType: typeof revived.value,
            bigintValue: String(revived.value),
          };
        } catch (error) {
          return {
            rejected: true,
            name: (error as Error).name,
            message: (error as Error).message,
          };
        }
      }
      case "ser-collections": {
        try {
          const revived = await step.do("collections", async () => {
            const map = new Map<string, unknown>([
              ["key", { deep: new Date("2026-06-07T08:09:10.011Z") }],
              ["num", 7],
            ]);
            const set = new Set<unknown>(["a", 2, { third: true }]);
            return { map, set };
          });
          return {
            mapIsMap: revived.map instanceof Map,
            mapSize: revived.map instanceof Map ? revived.map.size : -1,
            mapDeepIsDate:
              revived.map instanceof Map &&
              (revived.map.get("key") as any)?.deep instanceof Date,
            setIsSet: revived.set instanceof Set,
            setSize: revived.set instanceof Set ? revived.set.size : -1,
            setHasObject:
              revived.set instanceof Set &&
              [...revived.set].some(
                (item) => typeof item === "object" && (item as any).third === true,
              ),
          };
        } catch (error) {
          return { rejected: true, name: (error as Error).name };
        }
      }
      case "ser-binary": {
        try {
          const revived = await step.do("binary", async () => {
            const buffer = new Uint8Array([1, 2, 250, 255]).buffer;
            const view = new DataView(new Uint8Array([9, 8, 7, 6]).buffer);
            return { buffer, view, typed: new Uint16Array([513, 1027]) };
          });
          return {
            abIsArrayBuffer: revived.buffer instanceof ArrayBuffer,
            abBytes:
              revived.buffer instanceof ArrayBuffer
                ? [...new Uint8Array(revived.buffer)]
                : [],
            dvIsDataView: revived.view instanceof DataView,
            dvByte: revived.view instanceof DataView ? revived.view.getUint8(0) : -1,
            typedName: revived.typed?.constructor?.name,
            typedValues: ArrayBuffer.isView(revived.typed) ? [...revived.typed] : [],
          };
        } catch (error) {
          return { rejected: true, name: (error as Error).name };
        }
      }
      case "ser-error": {
        try {
          const revived = await step.do("err", async () => {
            const cause = new TypeError("inner-cause");
            const error = new RangeError("outer-error", { cause });
            (error as any).code = "E_RANGE";
            return error;
          });
          return {
            isError: revived instanceof Error,
            name: revived.name,
            message: revived.message,
            code: (revived as any).code,
            causeIsError: (revived as any).cause instanceof Error,
            causeName: (revived as any).cause?.name,
          };
        } catch (error) {
          return { rejected: true, name: (error as Error).name };
        }
      }
      case "ser-unsupported": {
        try {
          await step.do("unserializable", async () => () => "nope");
          return { rejected: false };
        } catch (error) {
          return {
            rejected: true,
            name: (error as Error).name,
          };
        }
      }
      case "ser-cyclic": {
        try {
          await step.do("cyclic", async () => {
            const object: any = {};
            object.self = object;
            return object;
          });
          return { rejected: false };
        } catch (error) {
          return {
            rejected: true,
            name: (error as Error).name,
          };
        }
      }
      // Long-lived targets for the orchestrated lifecycle probes. The probe
      // driver pauses/restarts/terminates/deletes these instances; the 30s
      // sleep keeps them suspended inside the 30s probe HTTP timeout.
      case "sleep-long": {
        await step.do("entry", async () => "ready");
        await step.sleep("hold", 30_000);
        return { done: true };
      }
      case "rollback-target": {
        await step.do("recorded", async () => "ok", {
          rollback: async () => {},
        });
        await step.sleep("hold", 30_000);
        return { done: true };
      }
      case "restart-target": {
        await step.do("first", async () => "one");
        await step.do("second", async () => "two");
        await step.sleep("hold", 30_000);
        return { done: true };
      }
      case "entrypoint-ctx": {
        const ctx = this.ctx as unknown as Record<string, unknown> | undefined;
        const tracing = ctx?.tracing as Record<string, unknown> | undefined;
        const probe = (fn: () => unknown): unknown => {
          try {
            return fn();
          } catch (error) {
            return `throws:${(error as Error).name}`;
          }
        };
        const probeAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
          try {
            return await fn();
          } catch (error) {
            return `throws:${(error as Error).name}`;
          }
        };
        const exportsObj = ctx?.exports as Record<string, unknown> | undefined;
        const exportsDefault = exportsObj?.default as
          | { fetch?: (request: Request) => Promise<Response> }
          | undefined;
        // Note: workerd exposes configured Workflow classes on ctx.exports
        // (server test "Server: configured Workflow is exposed through
        // ctx.exports"), but `wrangler dev` does not — a dev/oracle
        // limitation, so named-export presence is covered by local e2e
        // rather than this differential.
        const spanProbe = (method: "enterSpan" | "startActiveSpan") =>
          probeAsync(async () => {
            const fn = tracing?.[method] as
              | ((name: string, callback: (span: unknown) => unknown) => unknown)
              | undefined;
            if (typeof fn !== "function") return "not-a-function";
            let endedDuringCallback = false;
            let ended = false;
            const result = fn.call(tracing, "probe-span", async (span) => {
                const end = span.end as (() => void) | undefined;
                if (typeof end === "function") {
                  (span as { end: () => void }).end = () => {
                    ended = true;
                    return end.call(span);
                  };
                }
                const before = tracing?.getActiveSpan() === span;
                await new Promise((resolve) => setTimeout(resolve, 5));
                endedDuringCallback = ended;
                return {
                  before,
                  afterAwait: tracing?.getActiveSpan() === span,
                };
              });
            const awaited = await result;
            return {
              ...((awaited ?? {}) as Record<string, unknown>),
              afterExit: tracing?.getActiveSpan() === undefined,
              endedDuringCallback,
              endedAfterSettle: ended,
            };
          });
        return {
          hasCtx: ctx != null,
          waitUntil: typeof ctx?.waitUntil,
          passThroughOnException: typeof ctx?.passThroughOnException,
          abort: typeof ctx?.abort,
          props: typeof ctx?.props,
          propsValue: probe(() => JSON.stringify(ctx?.props ?? null)),
          exports: typeof exportsObj,
          exportsHasDefault: probe(() =>
            exportsObj == null ? null : "default" in exportsObj,
          ),
          exportsDefaultFetch: await probeAsync(async () => {
            if (typeof exportsDefault?.fetch !== "function") return "not-a-function";
            const response = await exportsDefault.fetch(
              new Request("http://loopback.invalid/health"),
            );
            return { status: response.status, body: await response.json() };
          }),
          exportsDefaultFetchStr: await probeAsync(async () => {
            if (typeof exportsDefault?.fetch !== "function") return "not-a-function";
            const response = await exportsDefault.fetch(
              "http://loopback.invalid/health",
              { method: "GET" },
            );
            return { status: response.status, body: await response.json() };
          }),
          tracing: typeof tracing,
          tracingSpan: typeof tracing?.Span,
          tracingActiveSpan: probe(() =>
            typeof tracing?.getActiveSpan === "function"
              ? (tracing.getActiveSpan as () => unknown)() === undefined
              : "not-a-function",
          ),
          tracingEnterSpan: await spanProbe("enterSpan"),
          tracingStartActiveSpan: await spanProbe("startActiveSpan"),
          cache: typeof ctx?.cache,
          access: typeof ctx?.access,
        };
      }
      case "rollback": {
        await step.do(
          "first",
          async () => "first",
          { rollback: async () => {} },
        );
        await step.do(
          "second",
          async () => "second",
          { rollback: async () => {} },
        );
        throw new Error("rollback-probe");
      }
      default:
        throw new Error("unknown probe: " + event.payload.probe);
    }
  }
}

async function collect(instance: any) {
  const events = [];
  const subscription = await instance.subscribe();
  try {
    for (;;) {
      const next = await subscription.next();
      if (next.done) break;
      events.push(next.value);
      if (events.length > 256) throw new Error("probe emitted too many events");
    }
  } finally {
    subscription[Symbol.dispose]?.();
  }
  return {
    status: await instance.status(),
    events,
  };
}

async function waitStatus(
  instance: any,
  want: string[],
  timeoutMs = 10000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  for (;;) {
    try {
      const status = await instance.status();
      last = status.status;
      if (want.includes(last)) return last;
    } catch (error) {
      last = "error:" + (error as Error).name;
    }
    if (Date.now() >= deadline) return "timeout:" + last;
    await delay(100);
  }
}

// Live collector for orchestrated probes: subscribes once and accumulates
// events in the background so callers never miss a transition while polling.
class EventCollector {
  events: any[] = [];
  done = false;
  error: unknown = null;
  private pump: Promise<void>;

  constructor(instance: any, options?: { filter?: string[] }) {
    this.pump = this.run(instance, options).catch((error) => {
      this.error = error;
    });
  }

  private async run(instance: any, options?: { filter?: string[] }) {
    const subscription = await instance.subscribe(options);
    try {
      for (;;) {
        const next = await subscription.next();
        if (next.done) break;
        this.events.push(next.value);
        if (this.events.length > 512) throw new Error("too many events");
      }
    } finally {
      subscription[Symbol.dispose]?.();
      this.done = true;
    }
  }

  count(type: string, stepName?: string) {
    return this.events.filter(
      (event) =>
        event.type === type && (stepName == null || event.stepName === stepName),
    ).length;
  }

  async settle(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.done) {
      if (Date.now() >= deadline) {
        throw new Error("subscription did not reach a terminal event");
      }
      await delay(50);
    }
    await this.pump;
  }
}

async function until(condition: () => boolean, timeoutMs = 10000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for " + label);
    await delay(50);
  }
}

function errShape(error: unknown) {
  return { name: (error as Error).name, message: (error as Error).message };
}

function errName(error: unknown) {
  return (error as Error).name;
}

const ORCHESTRATED: Record<
  string,
  (env: any, request: Request, ctx: any) => Promise<any>
> = {
  // Binding CRUD: duplicate create, get, createBatch idempotence, deleteBatch
  // per-instance error reporting, workflow-scoped ID semantics.
  async "binding-crud"(env) {
    const out: Record<string, unknown> = {};
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const idA = "crud-a-" + suffix;
    const idB = "crud-b-" + suffix;

    const first = await env.ORACLE.create({
      id: idA,
      params: { probe: "basic" },
    });
    out.create = typeof first.id === "string" && first.id.length > 0;

    try {
      await env.ORACLE.create({ id: idA, params: { probe: "basic" } });
      out.duplicateCreate = "accepted";
    } catch (error) {
      out.duplicateCreate = errName(error);
    }

    const got = await env.ORACLE.get(idA);
    // The instance is created with the fast `basic` probe; poll until it
    // settles rather than racing the scheduler.
    out.getStatus = await waitStatus(got, ["complete", "errored"], 15000);

    const batch = await env.ORACLE.createBatch([
      { id: idB, params: { probe: "basic" } },
      { id: "crud-c-" + suffix, params: { probe: "basic" } },
    ]);
    out.batchCreated = batch.length;

    try {
      const again = await env.ORACLE.createBatch([
        { id: idB, params: { probe: "basic" } },
      ]);
      out.batchDuplicate = { count: again.length };
    } catch (error) {
      out.batchDuplicate = errShape(error);
    }

    const drained = await env.ORACLE.get(idB);
    await waitStatus(drained, ["complete"], 15000);

    const deleted = await env.ORACLE.deleteBatch([idA, idB, "missing-" + suffix]);
    out.deleteResult = {
      deleted: deleted.deleted.length,
      errors: deleted.errors.length,
      errorCode: deleted.errors[0]?.code ?? null,
    };
    return out;
  },

  // subscribe() filter + cursor resume against a completed instance.
  async "subscribe-filter"(env) {
    const instance = await env.ORACLE.create({ params: { probe: "basic" } });
    await waitStatus(instance, ["complete", "errored"], 15000);

    const filtered = new EventCollector(instance, {
      filter: ["step_completed", "workflow_completed"],
    });
    await filtered.settle();

    const all = new EventCollector(instance);
    await all.settle();
    const cursor = all.events.length > 1 ? all.events[1].eventId : 0;

    const resumed = new EventCollector(instance, { cursor });
    await resumed.settle();

    return {
      filteredTypes: filtered.events.map((event) => event.type),
      resumedTypes: resumed.events.map((event) => event.type),
      resumedSkipsFirst: !resumed.events.some(
        (event) => event.eventId === all.events[0]?.eventId,
      ),
    };
  },

  // pause during a durable wait, resume, then terminate.
  async "pause-resume"(env) {
    const instance = await env.ORACLE.create({
      params: { probe: "sleep-long" },
    });
    const collector = new EventCollector(instance);
    await until(
      () => collector.count("sleep_started", "hold-1") >= 1,
      15000,
      "sleep_started(hold)",
    );
    await instance.pause();
    const paused = await waitStatus(instance, ["paused", "waitingForPause"], 8000);
    if (paused === "waitingForPause") {
      await waitStatus(instance, ["paused"], 8000);
    }
    await instance.resume();
    await until(
      () => collector.count("sleep_started", "hold-1") >= 1 && !collector.done,
      5000,
      "post-resume activity",
    );
    await instance.terminate();
    await collector.settle();
    const status = await instance.status();
    return {
      paused,
      final: status.status,
    };
  },

  // terminate({ rollback: true }) runs registered rollback handlers.
  async "terminate-rollback"(env) {
    const instance = await env.ORACLE.create({
      params: { probe: "rollback-target" },
    });
    const collector = new EventCollector(instance);
    await until(
      () => collector.count("sleep_started", "hold-1") >= 1,
      15000,
      "sleep_started(hold)",
    );
    await instance.terminate({ rollback: true });
    await collector.settle(15000);
    const status = await instance.status();
    return { final: status.status };
  },

  // restart({ from }) re-executes from the named step onward.
  async "restart-from"(env) {
    const instance = await env.ORACLE.create({
      params: { probe: "restart-target" },
    });
    const collector = new EventCollector(instance);
    await until(
      () => collector.count("sleep_started", "hold-1") >= 1,
      15000,
      "first sleep_started(hold)",
    );
    const preRestartMax = Math.max(
      0,
      ...collector.events.map((event) => event.timestamp ?? 0),
    );
    await instance.restart({ from: { name: "second" } });
    // A restart may invalidate the original subscription upstream — collect the
    // post-restart stream through a fresh subscription as well. A fresh
    // subscription may replay pre-restart history (with original timestamps),
    // so count only events timestamped after every pre-restart event.
    const restarted = new EventCollector(instance);
    // Count per subscription (both live subscriptions see post-restart events)
    // and take the max — covers upstream variants where one stream stalls.
    const afterRestart = (type: string, stepName: string) =>
      Math.max(
        collector.events.filter(
          (event) =>
            event.type === type &&
            event.stepName === stepName &&
            (event.timestamp ?? 0) > preRestartMax,
        ).length,
        restarted.events.filter(
          (event) =>
            event.type === type &&
            event.stepName === stepName &&
            (event.timestamp ?? 0) > preRestartMax,
        ).length,
      );
    await until(
      () => afterRestart("sleep_started", "hold-1") >= 1,
      25000,
      "post-restart sleep_started(hold)",
    );
    await instance.terminate();
    await collector.settle();
    await restarted.settle();
    return {
      firstStepStarts: collector.count("step_started", "first-1"),
      secondStepStarts: afterRestart("step_started", "second-1"),
      secondStepCompletes: afterRestart("step_completed", "second-1"),
      final: (await instance.status()).status,
    };
  },

  // delete() removes the instance; subsequent status/get fail explicitly.
  async "delete-instance"(env) {
    const instance = await env.ORACLE.create({
      params: { probe: "sleep-long" },
    });
    await waitStatus(instance, ["waiting", "running", "paused"], 10000);
    await instance.delete();
    const out: Record<string, unknown> = { deleted: true };
    try {
      const status = await instance.status();
      out.statusAfterDelete = status.status;
    } catch (error) {
      out.statusAfterDelete = errName(error);
    }
    try {
      const again = await env.ORACLE.get(instance.id);
      out.getAfterDelete = (await again.status()).status;
    } catch (error) {
      out.getAfterDelete = errName(error);
    }
    return out;
  },

  // Default Worker HTTP surface: routed responses, streamed bodies, multiple
  // Set-Cookie headers, ctx.waitUntil, and inbound request body echo — all
  // observed through real HTTP against the same dev server.
  async "worker-fetch"(env, request) {
    const origin = new URL(request.url).origin;
    const out: Record<string, unknown> = {};

    const health = await fetch(origin + "/health");
    out.health = health.status;

    const missing = await fetch(origin + "/missing");
    out.missing = missing.status;

    const streamed = await fetch(origin + "/streamed");
    const reader = streamed.body!.getReader();
    let chunks = 0;
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
      text += decoder.decode(next.value, { stream: true });
    }
    out.streamedStatus = streamed.status;
    out.streamedChunks = chunks;
    out.streamedText = text;

    const cookies = await fetch(origin + "/cookies");
    out.setCookies = cookies.headers.getSetCookie().length;

    await fetch(origin + "/wait-until-arm");
    await delay(400);
    const read = await fetch(origin + "/wait-until-read");
    out.waitUntilMarker = await read.text();

    const echo = await fetch(origin + "/echo", {
      method: "POST",
      body: "echo-payload-" + "x".repeat(64),
    });
    out.echoBody = await echo.text();

    return out;
  },
};

// Probes whose workflow waits on a "go" event that arrives before the wait
// starts (buffered delivery is part of the contract).
const SEND_EVENT_PROBES = new Set(["wait-for-event", "durable-with-event"]);

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/streamed") {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const part of ["chunk-1;", "chunk-2;", "chunk-3"]) {
            controller.enqueue(encoder.encode(part));
            await delay(20);
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (request.method === "GET" && url.pathname === "/cookies") {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "first=1; Path=/");
      headers.append("set-cookie", "second=2; Path=/");
      return new Response("cookies", { headers });
    }
    if (request.method === "GET" && url.pathname === "/wait-until-arm") {
      waitUntilMarker = "unset";
      ctx?.waitUntil?.(delay(80).then(() => {
        waitUntilMarker = "set";
      }));
      return new Response("armed");
    }
    if (request.method === "GET" && url.pathname === "/wait-until-read") {
      return new Response(waitUntilMarker);
    }
    if (request.method === "POST" && url.pathname === "/echo") {
      return new Response(await request.arrayBuffer());
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json() as { probe: string; id: string };

    const orchestrated = ORCHESTRATED[body.probe];
    if (orchestrated) {
      return Response.json({
        probe: body.probe,
        status: { status: "complete" },
        output: await orchestrated(env, request, ctx),
        events: [],
      });
    }

    const instance = await env.ORACLE.create({
      id: body.id,
      params: { probe: body.probe },
    });

    if (SEND_EVENT_PROBES.has(body.probe)) {
      await instance.sendEvent({ type: "go", payload: { value: 42 } });
    }

    const collected = await collect(instance);
    return Response.json({
      probe: body.probe,
      status: collected.status,
      events: collected.events,
    });
  },
};
