import { WorkflowEntrypoint } from "cloudflare:workers";
import { observeDuplicate, observeMissing } from "../observe.mjs";

export class BindingErrorsWorkflow extends WorkflowEntrypoint {
  async run(_event, step) {
    return await step.do("answer", async () => 42);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    const { id, contenders } = await request.json();
    if (path === "/missing") return Response.json(await observeMissing(env.WORKFLOW, id));
    if (path === "/duplicate") return Response.json(await observeDuplicate(env.WORKFLOW, id, contenders));
    // Each generated/shrunk case must start with the same empty state.
    if (path === "/cleanup") {
      await env.WORKFLOW.deleteBatch([id]);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
