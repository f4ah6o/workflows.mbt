import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

type Params = { probe: string };

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
      case "wait-for-event": {
        const received = await step.waitForEvent<{ value: number }>(
          "gate",
          { type: "go", timeout: "1 minute" },
        );
        return { type: received.type, payload: received.payload };
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

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json() as { probe: string; id: string };
    const instance = await env.ORACLE.create({
      id: body.id,
      params: { probe: body.probe },
    });

    if (body.probe === "wait-for-event") {
      await instance.sendEvent({ type: "go", payload: { value: 42 } });
    }

    return Response.json({
      probe: body.probe,
      ...(await collect(instance)),
    });
  },
};
