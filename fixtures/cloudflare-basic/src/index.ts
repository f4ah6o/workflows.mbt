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
