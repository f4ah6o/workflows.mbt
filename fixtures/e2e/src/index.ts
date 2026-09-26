import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

type BaseParams = { baseUrl: string };

export class DurableWorkflow extends WorkflowEntrypoint<{}, BaseParams & { sleepMs: number }> {
  async run(
    event: WorkflowEvent<BaseParams & { sleepMs: number }>,
    step: WorkflowStep,
  ) {
    const a = await step.do("A", async () => {
      const response = await fetch(`${event.payload.baseUrl}/A`);
      if (!response.ok) throw new Error("A failed");
      return "a";
    });

    const b = await step.do("B", async () => {
      const response = await fetch(`${event.payload.baseUrl}/B`);
      if (!response.ok) throw new Error("B failed");
      return "b";
    });

    await step.sleep("pause", event.payload.sleepMs);

    const c = await step.do("C", async () => {
      const response = await fetch(`${event.payload.baseUrl}/C`);
      if (!response.ok) throw new Error("C failed");
      return "c";
    });

    return { a, b, c };
  }
}

export class RetryWorkflow extends WorkflowEntrypoint<{}, BaseParams> {
  async run(event: WorkflowEvent<BaseParams>, step: WorkflowStep) {
    return await step.do(
      "retry-me",
      {
        retries: {
          limit: 3,
          delay: 80,
          backoff: "constant",
        },
      },
      async ({ attempt }) => {
        const response = await fetch(`${event.payload.baseUrl}/retry`);
        if (!response.ok) throw new Error(`attempt ${attempt} failed`);
        return { attempt };
      },
    );
  }
}

export class ApprovalWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    const approval = await step.waitForEvent<{ approved: boolean }>(
      "approval",
      { type: "approved", timeout: "5 seconds" },
    );
    return approval.payload;
  }
}

export class DuplicateWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    const output = [];
    for (let i = 0; i < 3; i += 1) {
      output.push(
        await step.do("process", async ({ step: current }) => ({
          i,
          count: current.count,
        })),
      );
    }
    return output;
  }
}
