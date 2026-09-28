// A practical Cloudflare Workflow — plain upstream APIs only, runs unchanged
// under `wrangler dev` and under `workflows dev`. Used by
// scripts/consumer-scenario.mjs to prove the full vertical:
//
//   external HTTP side effect -> retry -> waitForEvent -> restart -> complete
//
// The external side effect carries a stable business idempotency key (the
// order id from the workflow event). That key — not the step or instance id —
// is what lets the downstream service deduplicate a call that is retried
// because the runtime was killed after the service applied the effect but
// before the step result was persisted. The runtime is at-least-once: the
// callback may run again after a crash. Nothing here claims exactly-once
// external delivery.

import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";
import type {
  WorkflowEvent,
} from "cloudflare:workers";

type Params = { orderId?: string; serviceUrl?: string };

export class ChargeWorkflow extends WorkflowEntrypoint<{}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const orderId = event.payload?.orderId ?? "unknown";
    const serviceUrl = event.payload?.serviceUrl;
    if (!serviceUrl) throw new Error("serviceUrl param required");

    // External side effect with a retry policy: a 5xx from the downstream
    // service must retry the step until it is accepted.
    const charge = await step.do(
      "apply charge",
      { retries: { limit: 3, delay: 100, backoff: "constant" } },
      async () => {
        const response = await fetch(`${serviceUrl}/charge`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": orderId,
          },
          body: JSON.stringify({ orderId }),
        });
        if (!response.ok) throw new Error(`charge failed: HTTP ${response.status}`);
        return response.json();
      },
    );

    // A human/external gate: the workflow suspends durably until the
    // "approved" event arrives — even across a full process restart.
    const approval = await step.waitForEvent<{ approved: boolean }>(
      "await approval",
      { type: "approved", timeout: "5 minutes" },
    );

    const finalized = await step.do("finalize", async () => {
      const response = await fetch(`${serviceUrl}/finalize`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": orderId,
        },
        body: JSON.stringify({ orderId, approved: approval.payload?.approved === true }),
      });
      if (!response.ok) throw new Error(`finalize failed: HTTP ${response.status}`);
      return response.json();
    });

    return { orderId, charge, finalized };
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
      const instance = await env.CHARGE_WORKFLOW.create({
        id: body.id,
        params: body.params ?? {},
      });
      return Response.json(await instance.status());
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("id required", { status: 400 });
      const instance = await env.CHARGE_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    if (request.method === "POST" && url.pathname === "/event") {
      const id = url.searchParams.get("id");
      const type = url.searchParams.get("type");
      if (!id || !type) return new Response("id and type required", { status: 400 });
      const instance = await env.CHARGE_WORKFLOW.get(id);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      await instance.sendEvent({ type, payload: body });
      return Response.json({ sent: true });
    }

    return new Response("not found", { status: 404 });
  },
};
