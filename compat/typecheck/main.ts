// Compile-time fixture: exercises the ctx.exports loopback type surface the
// way normal Worker source does — no casts. Typechecked by
// `npm run compat:typecheck` (tsc -p compat/typecheck).
import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";

type Env = { [key: string]: unknown };
type Params = { url?: string };

export class TypecheckWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(
    _event: WorkflowEvent<Params>,
    _step: WorkflowStep,
  ): Promise<{ statuses: number[]; instanceId: string }> {
    // Service-stub loopback: Fetcher-compatible call signatures.
    const fromRequest = await this.ctx.exports.default.fetch(
      new Request("https://example.com/health"),
    );
    const fromInputInit = await this.ctx.exports.default.fetch(
      "https://example.com/health",
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    );
    const fromUrl = await this.ctx.exports.default.fetch(
      new URL("https://example.com/health"),
    );

    // WorkflowEntrypoint export resolves to a typed Workflow<Params> binding.
    const instance = await this.ctx.exports.TypecheckWorkflow.create({
      params: { url: "https://example.com" },
    });
    const existing: { id: string } = await this.ctx.exports.TypecheckWorkflow.get(
      instance.id,
    );

    return {
      statuses: [fromRequest.status, fromInputInit.status, fromUrl.status],
      instanceId: existing.id,
    };
  }
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    return new Response(`ok:${request.method}`);
  },
};
