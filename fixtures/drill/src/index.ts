import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

// Fallback drill fixture: a representative Cloudflare Workflow exercising a
// durable step, a suspension (sleep) long enough to crash mid-flight, and a
// second durable step. The same source runs under `wrangler dev` and the
// workflows.mbt dev server; compat/run-drill.mjs kills the local runtime
// during the sleep and verifies restart from persisted state.

type Params = { marker?: string };

export class DrillWorkflow extends WorkflowEntrypoint<{}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const first = await step.do("durable-first", async () => ({
      at: "first",
      marker: event.payload?.marker ?? null,
    }));
    await step.sleep("suspend", 3000);
    const second = await step.do("durable-second", async () => ({
      at: "second",
      sawFirst: first.at,
    }));
    return { first, second };
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    if (request.method === "POST" && url.pathname === "/create") {
      const body = (await request.json()) as { id?: string; params?: Params };
      const instance = await env.DRILL.create({
        id: body.id,
        params: body.params ?? {},
      });
      return Response.json(await instance.status());
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("id required", { status: 400 });
      const instance = await env.DRILL.get(id);
      return Response.json(await instance.status());
    }
    return new Response("not found", { status: 404 });
  },
};
