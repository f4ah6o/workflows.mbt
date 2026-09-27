import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";
import type {
  WorkflowEvent,
} from "cloudflare:workers";

type Env = {};
type Params = {
  name?: string;
  url: string;
};

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const data = await step.do("fetch data", async () => {
      const response = await fetch(event.payload.url);
      return await response.json();
    });

    await step.sleep("pause", 20);

    const result = await step.do(
      "process data",
      {
        retries: {
          limit: 3,
          delay: 5,
          backoff: "linear",
        },
      },
      async () => {
        return {
          name: event.payload.name ?? "World",
          data,
        };
      },
    );

    return result;
  }
}


export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/wait-until") {
      const target = url.searchParams.get("target");
      if (!target) return new Response("target is required", { status: 400 });
      ctx.waitUntil((async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await fetch(target);
      })());
      return new Response("accepted");
    }

    if (request.method === "GET" && url.pathname === "/stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first\n"));
          setTimeout(() => {
            controller.enqueue(encoder.encode("second\n"));
            controller.close();
          }, 200);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/first-chunk") {
      const reader = request.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      return new Response(first.value ?? new Uint8Array(), {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (request.method === "GET" && url.pathname === "/loopback") {
      const target = new URL("/cookies", request.url);
      const viaRequest = await ctx.exports.default.fetch(new Request(target));
      const viaStringInit = await ctx.exports.default.fetch(target.href, {
        method: "GET",
      });
      return new Response(
        `loopback:${viaRequest.status}:${await viaRequest.text()}|str:${viaStringInit.status}:${await viaStringInit.text()}`,
      );
    }

    if (request.method === "GET" && url.pathname === "/cookies") {
      const headers = new Headers();
      headers.append("Set-Cookie", "first=one; Path=/; HttpOnly");
      headers.append("Set-Cookie", "second=two; Path=/; SameSite=Lax");
      headers.set("x-cookie-test", "ok");
      return new Response("cookies", { headers });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const body = await request.json() as {
      id?: string;
      name?: string;
      url: string;
    };
    const instance = await env.MY_WORKFLOW.create({
      id: body.id,
      params: { name: body.name, url: body.url },
    });
    return Response.json(await instance.status());
  },
};
