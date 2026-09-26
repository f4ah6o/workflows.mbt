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

export declare class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  env: Env;
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
