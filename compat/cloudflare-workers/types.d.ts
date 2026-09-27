export type WorkflowEvent<T = unknown> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
  schedule?: {
    cron: string;
    scheduledTime: number;
  };
};

export type WorkflowDelayFunction = (input: {
  ctx: WorkflowStepContext;
  error: Error;
}) => string | number | Promise<string | number>;

export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: string | number | WorkflowDelayFunction;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
  sensitive?: "output";
};

export type WorkflowStepContext = {
  step: { name: string; count: number };
  attempt: number;
  config: WorkflowStepConfig;
};

export type WorkflowRollbackContext<T = unknown> = {
  ctx: WorkflowStepContext;
  error: Error | undefined;
  output: T | undefined;
};

export type WorkflowStepRollbackConfig = Pick<WorkflowStepConfig, "retries" | "timeout">;

export type WorkflowStepRollbackOptions<T = unknown> = {
  rollback: (input: WorkflowRollbackContext<T>) => Promise<void> | void;
  rollbackConfig?: WorkflowStepRollbackConfig;
};

export type WorkflowExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

export declare class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: WorkflowExecutionContext;
  env: Env;
  constructor(ctx: WorkflowExecutionContext, env: Env);
  run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
}

export declare class WorkflowStep {
  do<T>(
    name: string,
    callback: (ctx: WorkflowStepContext) => Promise<T> | T,
    options?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Promise<T> | T,
    options?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<{ type: string; payload: T; timestamp: Date }>;
}

export declare class NonRetryableError extends Error {}


export type WorkflowInstanceStatusName =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "errored"
  | "terminated"
  | "complete";

export type WorkflowInstanceEvent = {
  instanceId: string;
  eventId: number;
  timestamp: number;
} & (
  | { type: "workflow_queued" }
  | { type: "workflow_started"; params?: unknown }
  | { type: "workflow_running" }
  | { type: "workflow_paused" }
  | { type: "workflow_waiting_for_pause" }
  | { type: "workflow_waiting" }
  | { type: "workflow_completed"; output?: unknown }
  | { type: "workflow_errored"; error: { name: string; message: string } }
  | { type: "workflow_terminated" }
  | {
      type: "step_started";
      stepName: string;
      config?: {
        retries: {
          limit: number;
          delay: string | number | "[dynamic]";
          backoff?: "constant" | "linear" | "exponential";
        };
        timeout: string | number;
        sensitive?: "output";
      };
    }
  | { type: "step_completed"; stepName: string; output?: unknown }
  | { type: "step_errored"; stepName: string }
  | { type: "attempt_started"; stepName: string; attempt: number }
  | { type: "attempt_completed"; stepName: string; attempt: number }
  | {
      type: "attempt_errored";
      stepName: string;
      attempt: number;
      retryDelayMs?: number;
      error: { name: string; message: string };
    }
  | { type: "sleep_started"; stepName: string; durationMs: number }
  | { type: "sleep_completed"; stepName: string }
  | { type: "wait_started"; stepName: string; eventType: string }
  | { type: "wait_completed"; stepName: string }
  | { type: "wait_timed_out"; stepName: string }
  | { type: "rollback_started" }
  | { type: "rollback_step_started"; stepName: string; config?: WorkflowStepConfig }
  | { type: "rollback_step_completed"; stepName: string }
  | {
      type: "rollback_step_errored";
      stepName: string;
      error: { name: string; message: string };
    }
  | { type: "rollback_attempt_started"; stepName: string; attempt: number }
  | { type: "rollback_attempt_completed"; stepName: string; attempt: number }
  | {
      type: "rollback_attempt_errored";
      stepName: string;
      attempt: number;
      retryDelayMs?: number;
      error: { name: string; message: string };
    }
  | { type: "rollback_completed" }
  | { type: "rollback_errored" }
);

export type WorkflowInstanceSubscribeOptions = {
  cursor?: number;
  filter?: WorkflowInstanceEvent["type"][];
};

export interface WorkflowInstanceSubscription {
  next(): Promise<
    | { value: WorkflowInstanceEvent; done: false }
    | { value: undefined; done: true }
  >;
  [Symbol.dispose](): void;
}

export type WorkflowRetentionOptions = {
  successRetention?: string | number;
  errorRetention?: string | number;
};

export type WorkflowInstanceCreateOptions<Params = unknown> = {
  id?: string;
  params?: Params;
  retention?: WorkflowRetentionOptions;
};

export type WorkflowInstanceStatus<Output = unknown> = {
  id: string;
  workflowName: string;
  status: WorkflowInstanceStatusName;
  output?: Output;
  error?: { name: string; message: string; stack?: string | null };
  rollback:
    | { outcome: "complete" | "failed"; error?: { name: string; message: string } }
    | null;
  createdAt: Date;
  updatedAt: Date;
};

export declare class WorkflowInstance<Output = unknown> {
  readonly id: string;
  status(): Promise<WorkflowInstanceStatus<Output>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(options?: {
    from?: { name: string; count?: number; type?: string };
  }): Promise<void>;
  terminate(options?: { rollback?: boolean }): Promise<void>;
  delete(): Promise<void>;
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
  subscribe(
    options?: WorkflowInstanceSubscribeOptions,
  ): Promise<WorkflowInstanceSubscription>;
}

export declare class Workflow<Params = unknown, Output = unknown> {
  create(options?: WorkflowInstanceCreateOptions<Params>): Promise<WorkflowInstance<Output>>;
  get(id: string): Promise<WorkflowInstance<Output>>;
  createBatch(
    batch: Array<WorkflowInstanceCreateOptions<Params> & { id: string; params: Params }>,
  ): Promise<Array<WorkflowInstance<Output>>>;
  deleteBatch(ids: string[]): Promise<{
    deleted: Array<{ id: string }>;
    errors: Array<{ id: string; code: number; message: string }>;
  }>;
}
