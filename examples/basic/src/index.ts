// A minimal, ordinary Cloudflare Workflow — no workflows.mbt-specific APIs.
// `wrangler dev` and `workflows dev` run this file unchanged.
//
//   workflows doctor --config wrangler.jsonc   # preflight
//   workflows dev    --config wrangler.jsonc   # http://127.0.0.1:8787
//   curl -XPOST localhost:8787/create -d '{"id":"order-1","params":{"orderId":"A-1"}}'
//   curl 'localhost:8787/status?id=order-1'

import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";
import type {
  WorkflowEvent,
} from "cloudflare:workers";

type Params = { orderId?: string };

export class OrderWorkflow extends WorkflowEntrypoint<{}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const order = await step.do("load order", async () => ({
      id: event.payload?.orderId ?? "unknown",
      state: "received",
    }));

    // A durable boundary: the workflow suspends here and resumes from
    // persisted state even if the host process is killed and restarted.
    await step.sleep("wait for fulfilment", 3000);

    const receipt = await step.do("finalize receipt", async () => ({
      orderId: order.id,
      state: "fulfilled",
    }));

    return { order, receipt };
  }
}

// The default Worker export stays a plain Cloudflare `fetch` handler. These
// three routes are the minimal operator surface used by the runbook smoke
// check and by scripts/consumer-smoke.mjs.
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/create") {
      const body = (await request.json()) as { id?: string; params?: Params };
      const instance = await env.ORDER_WORKFLOW.create({
        id: body.id,
        params: body.params ?? {},
      });
      return Response.json(await instance.status());
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("id required", { status: 400 });
      const instance = await env.ORDER_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    return new Response("not found", { status: 404 });
  },
};
