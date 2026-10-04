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

export type TracingSpanStatus = {
  code: "unset" | "ok" | "error";
  message?: string;
};

export declare class Span {
  readonly isTraced: boolean;
  setAttribute(key: string, value: boolean | number | string): this;
  setAttributes(
    attributes: Record<string, boolean | number | string | undefined>,
  ): this;
  recordException(exception: unknown): void;
  updateName(name: string): this;
  setStatus(status: TracingSpanStatus): this;
  end(): void;
}

export interface Tracing {
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T;
  startActiveSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T;
  startSpan(name: string): Span;
  getActiveSpan(): Span | undefined;
  Span: typeof Span;
}

export interface CacheContext {
  purge(options: unknown): Promise<unknown>;
}

export interface CloudflareAccessContext {
  readonly aud: string;
  getIdentity(): Promise<unknown>;
}

// Loopback type surface for `ExecutionContext.exports`, equivalent to
// upstream `Cloudflare.Exports` (which maps `GlobalProps.mainModule` through
// `LoopbackForExport`). Populate `Cloudflare.GlobalProps.mainModule` via
// declaration merging — the same role the wrangler-generated
// `worker-configuration.d.ts` plays upstream:
//
//   declare namespace Cloudflare {
//     interface GlobalProps {
//       mainModule: typeof import("./index");
//     }
//   }
//
// Entries typed as a `WorkflowEntrypoint` subclass resolve to a `Workflow`
// binding; an `ExportedHandler`-shaped entry resolves to a `ServiceStub`.
// Upstream's `LoopbackForExport` additionally covers `WorkerEntrypoint` and
// `DurableObject` class exports; the local runtime has no service-binding or
// actor backing for those, so they map to `undefined` — a documented gap.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface GlobalProps {}
  }
}

type MainModule = Cloudflare.GlobalProps extends { mainModule: infer M }
  ? M
  : {};

export interface ExportedHandlerFetchHandler<Env = unknown> {
  (request: Request, env: Env, ctx: ExecutionContext):
    | Response
    | Promise<Response>;
}

export interface ExportedHandler<Env = unknown> {
  fetch?: ExportedHandlerFetchHandler<Env>;
  scheduled?(controller: unknown, env: Env, ctx: ExecutionContext): unknown;
  queue?(batch: unknown, env: Env, ctx: ExecutionContext): unknown;
  tail?(events: unknown, env: Env, ctx: ExecutionContext): unknown;
  trace?(traces: unknown, env: Env, ctx: ExecutionContext): unknown;
  test?(controller: unknown, env: Env, ctx: ExecutionContext): unknown;
}

// Fetcher-compatible loopback service stub. The public signatures are the
// pinned Fetcher surface: `fetch` normalizes `RequestInfo | URL` + `RequestInit`
// into a `Request`; `queue`/`scheduled` adapt the public call into a
// `MessageBatch`/`ScheduledController` event delivered to the handler and
// return the structured Fetcher result; `connect` opens an outbound socket at
// the runtime level and never reaches the handler. Ambient members
// (`SocketAddress`, `Socket`, `ServiceBindingQueueMessage`, …) come from
// `@cloudflare/workers-types`.
export interface ServiceStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  connect(
    address: SocketAddress | string,
    options?: SocketOptions,
  ): Socket;
  queue(
    queueName: string,
    messages: ServiceBindingQueueMessage[],
    metadata?: MessageBatchMetadata,
  ): Promise<FetcherQueueResult>;
  scheduled(
    options?: FetcherScheduledOptions,
  ): Promise<FetcherScheduledResult>;
}

export type LoopbackForExport<T> =
  T extends new (...args: any[]) => WorkflowEntrypoint<any, infer Params>
    ? Workflow<Params>
    : T extends ExportedHandler<any>
      ? ServiceStub
      : undefined;

export type Exports = {
  [K in keyof MainModule]: LoopbackForExport<MainModule[K]>;
};

// Mirrors the pinned Cloudflare ExecutionContext surface (workerd
// v1.20260925.2). `props`, `exports`, and `tracing` are always present;
// `cache`/`access` are optional upstream and remain undefined locally.
export interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly exports: Exports;
  readonly props: Props;
  cache?: CacheContext;
  readonly access?: CloudflareAccessContext;
  tracing: Tracing;
  abort(reason?: unknown): void;
}

/** @deprecated Use `ExecutionContext`; kept as an alias for earlier local code. */
export type WorkflowExecutionContext = ExecutionContext;

export declare abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env);
  run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<unknown>;
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

export type WorkflowInstanceLocationHint =
  | "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac"
  | "apac-ne" | "apac-se" | "oc" | "afr" | "me";

export type WorkflowInstanceCreateOptions<Params = unknown> = {
  id?: string;
  params?: Params;
  retention?: WorkflowRetentionOptions;
  /** Best-effort upstream placement preference; accepted without local routing. */
  locationHint?: WorkflowInstanceLocationHint;
};

export type WorkflowBatchCreateOptions<Params = unknown> =
  | {
      count: number;
      params?: Params;
      retention?: WorkflowRetentionOptions;
      locationHint?: WorkflowInstanceLocationHint;
      instances?: never;
    }
  | {
      instances: WorkflowInstanceCreateOptions<Params>[];
      count?: never;
      params?: never;
      retention?: never;
      locationHint?: never;
    };

export type WorkflowBatchCreateResult<Output = unknown> = {
  created: WorkflowInstance<Output>[];
  errors: Array<{ index: number; id?: string; code: number; message: string }>;
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
    options: WorkflowBatchCreateOptions<Params>,
  ): Promise<WorkflowBatchCreateResult<Output>>;
  /** @deprecated Use the object form to receive indexed per-instance errors. */
  createBatch(
    batch: Array<WorkflowInstanceCreateOptions<Params>>,
  ): Promise<Array<WorkflowInstance<Output>>>;
  deleteBatch(ids: string[]): Promise<{
    deleted: Array<{ id: string }>;
    errors: Array<{ id: string; code: number; message: string }>;
  }>;
}
