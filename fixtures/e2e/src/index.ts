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


export class ParallelWorkflow extends WorkflowEntrypoint<{}, BaseParams> {
  async run(event: WorkflowEvent<BaseParams>, step: WorkflowStep) {
    const [retried, stable] = await Promise.all([
      step.do(
        "parallel",
        { retries: { limit: 3, delay: 80, backoff: "constant" } },
        async ({ attempt, step: current }) => {
          const response = await fetch(`${event.payload.baseUrl}/retry`);
          if (!response.ok) throw new Error(`parallel attempt ${attempt} failed`);
          return { branch: "retry", attempt, count: current.count };
        },
      ),
      step.do("parallel", async ({ step: current }) => {
        const response = await fetch(`${event.payload.baseUrl}/parallel-stable`);
        if (!response.ok) throw new Error("parallel stable failed");
        return { branch: "stable", count: current.count };
      }),
    ]);
    return { retried, stable };
  }
}

export class ParallelRestartWorkflow extends WorkflowEntrypoint<{}, BaseParams & { sleepMs: number }> {
  async run(
    event: WorkflowEvent<BaseParams & { sleepMs: number }>,
    step: WorkflowStep,
  ) {
    const [a, _pause, b] = await Promise.all([
      step.do("parallel-A", async () => {
        const response = await fetch(`${event.payload.baseUrl}/parallel-A`);
        if (!response.ok) throw new Error("parallel A failed");
        return "a";
      }),
      step.sleep("parallel-pause", event.payload.sleepMs),
      step.do("parallel-B", async () => {
        const response = await fetch(`${event.payload.baseUrl}/parallel-B`);
        if (!response.ok) throw new Error("parallel B failed");
        return "b";
      }),
    ]);
    return { a, b };
  }
}

export class PromiseCombinatorsWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    const settled = await Promise.allSettled([
      step.do("settled-ok", async () => "ok"),
      step.do(
        "settled-error",
        { retries: { limit: 0, delay: 1, backoff: "constant" } },
        async () => {
          throw new Error("expected");
        },
      ),
    ]);
    const any = await Promise.any([
      step.do("any-first", async () => "first"),
      step.do("any-second", async () => "second"),
    ]);
    const race = await Promise.race([
      step.do("race-first", async () => "first"),
      step.do("race-second", async () => "second"),
    ]);
    return {
      settled: settled.map((entry) =>
        entry.status === "fulfilled"
          ? { status: entry.status, value: entry.value }
          : { status: entry.status, reason: entry.reason.message }
      ),
      any,
      race,
    };
  }
}


export class RollbackWorkflow extends WorkflowEntrypoint<{}, BaseParams> {
  async run(event: WorkflowEvent<BaseParams>, step: WorkflowStep) {
    await step.do(
      "rollback-first",
      async () => "forward-first",
      {
        rollback: async ({ output }) => {
          if (output !== "forward-first") throw new Error("rollback output mismatch");
          const response = await fetch(`${event.payload.baseUrl}/retry`);
          if (!response.ok) throw new Error("rollback retry requested");
        },
        rollbackConfig: {
          retries: { limit: 3, delay: 300, backoff: "constant" },
        },
      },
    );

    await step.do(
      "rollback-second",
      async () => "forward-second",
      {
        rollback: async ({ output }) => {
          if (output !== "forward-second") throw new Error("rollback output mismatch");
          const response = await fetch(`${event.payload.baseUrl}/rollback-B`);
          if (!response.ok) throw new Error("rollback B failed");
        },
      },
    );

    await step.waitForEvent("hold-for-termination", {
      type: "finish",
      timeout: "1 hour",
    });
    return "unexpected";
  }
}


export class ScheduledWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(event: WorkflowEvent<{}>, _step: WorkflowStep) {
    return {
      timestamp: event.timestamp,
      schedule: event.schedule ?? null,
    };
  }
}


export class ErrorWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    return await step.do(
      "always-error",
      { retries: { limit: 0, delay: 1, backoff: "constant" } },
      async () => {
        throw new Error("expected terminal error");
      },
    );
  }
}

export class PauseWorkflow extends WorkflowEntrypoint<{}, BaseParams> {
  async run(event: WorkflowEvent<BaseParams>, step: WorkflowStep) {
    await step.do("slow-boundary", async () => {
      const response = await fetch(`${event.payload.baseUrl}/slow`);
      if (!response.ok) throw new Error("slow failed");
      return "slow";
    });
    await step.do("after-pause", async () => {
      const response = await fetch(`${event.payload.baseUrl}/after-pause`);
      if (!response.ok) throw new Error("after pause failed");
      return "after";
    });
    return "done";
  }
}


export class AutomaticRollbackWorkflow extends WorkflowEntrypoint<{}, BaseParams> {
  async run(event: WorkflowEvent<BaseParams>, step: WorkflowStep) {
    await step.do(
      "auto-first",
      async () => ({ value: "first" }),
      {
        rollback: async ({ output, error }) => {
          if (output?.value !== "first") throw new Error("auto-first output mismatch");
          if (error?.message !== "automatic failure") throw new Error("auto-first cause mismatch");
          const response = await fetch(`${event.payload.baseUrl}/auto-rollback-first`);
          if (!response.ok) throw new Error("auto-first rollback failed");
        },
      },
    );

    await step.do(
      "auto-failing",
      { retries: { limit: 0, delay: 1, backoff: "constant" } },
      async () => {
        throw new Error("automatic failure");
      },
      {
        rollback: async ({ output, error }) => {
          if (output !== undefined) throw new Error("failed step rollback output must be undefined");
          if (error?.message !== "automatic failure") throw new Error("auto-failing cause mismatch");
          const response = await fetch(`${event.payload.baseUrl}/auto-rollback-failing`);
          if (!response.ok) throw new Error("auto-failing rollback failed");
        },
      },
    );
  }
}


export class StructuredReplayWorkflow extends WorkflowEntrypoint<
  {},
  BaseParams & { sleepMs: number }
> {
  async run(
    event: WorkflowEvent<BaseParams & { sleepMs: number }>,
    step: WorkflowStep,
  ) {
    const value = await step.do("structured-value", async () => {
      const response = await fetch(`${event.payload.baseUrl}/structured`);
      if (!response.ok) throw new Error("structured side effect failed");
      return {
        date: new Date("2026-09-26T00:00:00.000Z"),
        map: new Map([["answer", 42]]),
        set: new Set(["a", "b"]),
        bytes: new Uint8Array([1, 2, 255]),
        bigint: 9007199254740993n,
      };
    });

    await step.sleep("structured-pause", event.payload.sleepMs);

    return await step.do("verify-structured-replay", async () => ({
      date: value.date,
      dateIsDate: value.date instanceof Date,
      map: value.map,
      mapIsMap: value.map instanceof Map,
      set: value.set,
      setIsSet: value.set instanceof Set,
      bytes: value.bytes,
      bytesIsUint8Array: value.bytes instanceof Uint8Array,
      bigint: value.bigint,
      bigintIsBigInt: typeof value.bigint === "bigint",
    }));
  }
}

export class WrappedRaceWorkflow extends WorkflowEntrypoint<
  {},
  BaseParams & { sleepMs: number }
> {
  async run(
    event: WorkflowEvent<BaseParams & { sleepMs: number }>,
    step: WorkflowStep,
  ) {
    const winner = await step.do("durable-race-winner", async () => {
      return await Promise.race([
        step.do("race-slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          const response = await fetch(`${event.payload.baseUrl}/race-slow`);
          if (!response.ok) throw new Error("race slow failed");
          return "slow";
        }),
        step.do("race-fast", async () => {
          const response = await fetch(`${event.payload.baseUrl}/race-fast`);
          if (!response.ok) throw new Error("race fast failed");
          return "fast";
        }),
      ]);
    });
    await step.sleep("race-pause", event.payload.sleepMs);
    return await step.do("race-after-replay", async ({ step: current }) => ({
      winner,
      count: current.count,
    }));
  }
}


export class SensitiveWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    const secret = await step.do(
      "sensitive-output",
      { sensitive: "output" },
      async () => ({ token: "super-secret", visibleToWorkflow: true }),
    );
    return { preserved: secret.token === "super-secret" };
  }
}


export class DefaultConfigWorkflow extends WorkflowEntrypoint<{}, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    return await step.do("default-config", async (ctx) => ({
      retries: ctx.config.retries,
      timeout: ctx.config.timeout,
    }));
  }
}
