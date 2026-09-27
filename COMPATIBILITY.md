# Cloudflare Workflows compatibility

Compatibility oracle date: **2026-09-26**.

This matrix describes behavior covered by tests in this repository. It does not
claim complete Cloudflare Workers platform compatibility.

## Compatibility target

`workflows.mbt` targets existing Cloudflare Workflows TypeScript/JavaScript
source and Wrangler workflow configuration. Workflow source continues importing
`cloudflare:workers` and `cloudflare:workflows`; the local host redirects those
module specifiers without rewriting application source.

The durable execution kernel remains MoonBit-first. JavaScript owns module
loading, Web APIs, callback invocation, and narrow host bridges.

## WorkflowEntrypoint / event

- [x] `WorkflowEntrypoint.run(event, step)`
- [x] `this.env` injection
- [x] `this.ctx` — pinned `ExecutionContext` surface (`waitUntil`,
  `passThroughOnException`, `props`, `exports`, `tracing`, `abort`;
  `cache`/`access` remain undefined), verified against the oracle
- [x] `ctx.exports` loopback surface: every supported top-level export is an
  ordinary enumerable own property (workerd installs `ctxExports` via
  `v8Set`): `default` and other `ExportedHandler`-shaped exports are service
  stubs (`fetch(input, init)` normalizes to `Request`; other methods take
  public args + injected env/ctx) matching upstream `Fetcher` semantics, and
  every configured Workflow class resolves to a `Workflow` binding under its
  export name (workerd `Server: configured Workflow is exposed through
  ctx.exports`). `wrangler dev` does not implement any of this — a known
  dev/oracle limitation covered by local e2e, not matched. Gap:
  `WorkerEntrypoint`/`DurableObject` class exports are not backed (no
  service-binding/actor runtime locally); they map to `undefined` in the
  type surface. Typed via a module-aware `Exports` mapped type driven by
  `Cloudflare.GlobalProps.mainModule` (the wrangler-generated augmentation
  point)
- [x] `ctx.tracing` spans propagate via async context (`getActiveSpan()` holds
  across `await`); `enterSpan` AUTO_ENDs internally while `startActiveSpan` is
  MANUAL_END — neither path calls the public `span.end()`, matching workerd
- [x] `event.payload`
- [x] `event.timestamp`
- [x] `event.instanceId`
- [x] `event.workflowName`
- [x] scheduled-trigger `event.schedule = { cron, scheduledTime }`
- [x] scheduled instance creation is durable and idempotent across restart

`event.timestamp` is the local instance creation time. `scheduledTime` is the
UTC cron firing time.

## WorkflowStep

- [x] `step.do(name, callback)`
- [x] `step.do(name, config, callback)`
- [x] default retry config: 5 retries / 10 seconds / exponential
- [x] default per-attempt timeout: `"10 minutes"`
- [x] retry limit validation through 10,000 retries
- [x] static constant / linear / exponential retry delay
- [x] dynamic `WorkflowDelayFunction`
- [x] per-attempt timeout
- [x] resolved step context `{ step: { name, count }, attempt, config }`
- [x] `NonRetryableError`
- [x] `sensitive: "output"` subscription redaction
- [x] `step.sleep(name, milliseconds)`
- [x] `step.sleep(name, humanDuration)`
- [x] `step.sleepUntil(name, Date)`
- [x] `step.sleepUntil(name, unixMilliseconds)`
- [x] `sleepUntil` restores persisted ordinals across replay
- [x] `step.waitForEvent(name, { type, timeout })`
- [x] 24-hour default event timeout
- [x] events buffered before the wait is reached

### Parallel Promise semantics

- [x] multiple simultaneously pending durable operations
- [x] `Promise.all`
- [x] `Promise.allSettled`
- [x] `Promise.race`
- [x] `Promise.any`
- [x] concurrent branch retry while another branch completes
- [x] `step.do` + durable sleep
- [x] `step.do` + `waitForEvent`
- [x] restart during parallel execution does not rerun committed callbacks
- [x] duplicate names in parallel branches keep stable 1-origin counts
- [x] suspension remains durable even when `Promise.allSettled` consumes a rejection

Cloudflare documents an important limitation for bare `Promise.race()` and
`Promise.any()`: the first value observed during one execution is not guaranteed
to remain the cached winner during replay. `workflows.mbt` follows that
compatibility boundary instead of claiming stronger semantics. The documented
pattern of wrapping the combinator in an outer `step.do()` is covered by a
SIGKILL/restart fixture and preserves the durable winner.

### Rollback / compensation

- [x] successful `step.do` rollback registration
- [x] terminal failed `step.do` may participate in rollback
- [x] automatic rollback after a Workflow terminal error
- [x] `terminate({ rollback: true })`
- [x] reverse step-start rollback order
- [x] rollback receives original Workflow error and forward step output
- [x] rollback retry / timeout / non-retryable behavior
- [x] durable rollback registration and retry deadlines
- [x] SIGKILL/restart during rollback
- [x] completed rollback handlers are not rerun after restart
- [x] outward status remains `running` while rollback is active
- [x] final rollback outcome/error is exposed by `status()`

## Step identity / replay

- [x] identity includes instance, type, name, and 1-origin count
- [x] completed callback outputs replay without callback invocation
- [x] duplicate same-name steps in loops remain distinct
- [x] persisted ordinals are restored when replay skips nested callback work
- [x] process restart replays `run()` from the beginning
- [x] durable retry timers
- [x] durable sleep deadlines
- [x] durable event queue
- [x] real-process SIGKILL/restart E2E
- [x] structured non-JSON step values preserve types across SIGKILL/restart

External callback effects remain **at least once**. A process can fail after an
external effect succeeds but before its step result is committed, so exactly-once
external side effects are not claimed.

## Workflow binding

- [x] `create`
- [x] `get`
- [x] `createBatch`
- [x] `deleteBatch`
- [x] instance IDs are unique per Workflow, not process-global
- [x] internal SQLite storage IDs are opaque and collision-checked against user IDs
- [x] idempotent batch create behavior for existing IDs
- [x] repeated batch-delete IDs repeat their result
- [x] per-instance success/error retention options
- [x] Wrangler `default_retention` (including scheduled instances)
- [x] default Worker HTTP handler can invoke workflow bindings unchanged

Cloudflare account-plan default retention is not emulated locally when no
retention setting is supplied; see Known differences.

## WorkflowInstance

- [x] `id`
- [x] `status()`
- [x] `pause()`
- [x] active pause request uses `waitingForPause` until a durable boundary
- [x] `resume()`
- [x] `resume()` is a no-op when the instance is not paused
- [x] `restart()`
- [x] `restart({ from: { name, count, type } })`
- [x] `terminate()`
- [x] `terminate({ rollback: true })`
- [x] `delete()`
- [x] deleting a running instance prevents post-delete durable commits
- [x] self-delete stops execution at `await instance.delete()`
- [x] `sendEvent()`
- [x] `subscribe()`

### subscribe()

The internal subscription abstraction is backed by the durable execution event
log rather than an HTTP-specific transport.

- [x] retained history followed by live events
- [x] cursor resume
- [x] event-type filters
- [x] terminal completion
- [x] cancellation via `Symbol.dispose`
- [x] single in-flight `next()` backpressure guard
- [x] workflow lifecycle events
- [x] step events
- [x] attempt and retry events
- [x] sleep events
- [x] wait events
- [x] rollback step/attempt events
- [x] sensitive step output redaction

A REST streaming `GET .../subscribe` transport is not yet implemented.

## State model

Internal states:

| State | Produced | Outward behavior |
| --- | --- | --- |
| `queued` | yes | queued |
| `running` | yes | running |
| `waiting` | yes | waiting |
| `waitingForPause` | yes | pause requested; executor stops at next durable boundary |
| `paused` | yes | paused |
| `rollingBack` | yes | Workers-style `status()` reports `running` |
| `complete` | yes | terminal |
| `errored` | yes | terminal |
| `terminated` | yes | terminal |

Lifecycle mutations are rechecked before the executor commits a final result, so a
concurrent pause/terminate/rollback request cannot be overwritten by a stale
completion.

## Configuration / host

- [x] source keeps `cloudflare:workers` unchanged
- [x] `cloudflare:workflows` resolver for `NonRetryableError`
- [x] TypeScript transpilation via esbuild
- [x] `wrangler.jsonc` `main`
- [x] `workflows[].name`
- [x] `workflows[].binding`
- [x] `workflows[].class_name`
- [x] `workflows[].schedules`
- [x] numeric and named UTC cron fields including `MON-FRI`
- [x] Cloudflare numeric weekday numbering (`1=SUN` .. `7=SAT`)
- [x] `workflows[].default_retention`
- [x] top-level `vars`
- [x] local `.dev.vars` / `.env`
- [x] `secrets.required` local filtering / process-env fallback
- [x] compatibility flags are parsed and preserved for adapters
- [x] unknown Wrangler fields are ignored without source/config rewriting
- [x] separate `workflows.mbt.json` SQLite path override
- [x] native Node Web APIs including `fetch`, `Request`, `Response`, URL
- [x] default Worker `fetch(request, env, ctx)` host
- [x] `ctx.waitUntil()` returns the HTTP response without awaiting background work
- [x] `waitUntil()` tasks drain before runtime/host teardown
- [x] streamed Worker `Response.body` is forwarded incrementally with backpressure
- [x] inbound `Request.body` is a `ReadableStream` (not pre-buffered) for non-GET/HEAD requests
- [x] multiple `Set-Cookie` response headers are preserved as separate header values
- [ ] Wrangler named environments / `--env` overlay semantics
- [ ] full Wrangler clone

Cloudflare D1/KV/R2/Queues/Workers AI/Durable Objects/Service Bindings are not
emulated by the core runtime. Custom values/adapters may be injected into
`this.env`.

## Persistence

- [x] SQLite reference backend, WAL mode
- [x] workflows
- [x] workflow-scoped public instance IDs
- [x] instances and retention expiry
- [x] steps
- [x] attempts
- [x] timers
- [x] events
- [x] rollback registrations / attempts / retry deadlines
- [x] scheduled firing claims and scheduler cursors
- [x] execution event log / subscription cursor
- [x] atomic forward step success + rollback registration
- [x] atomic retry scheduling
- [x] atomic event consume + wait completion
- [x] restart-from-step invalidation
- [ ] PostgreSQL adapter
- [ ] multi-process executor lease/claim

## Serialization

- [x] JSON-compatible primitives, arrays, and plain objects
- [x] top-level and nested `undefined`
- [x] `Date`
- [x] `BigInt`
- [x] `RegExp`
- [x] `ArrayBuffer`
- [x] `DataView`
- [x] typed arrays
- [x] `Map`
- [x] `Set`
- [x] `Error`
- [x] nested combinations of the supported structured values
- [x] `NaN`, positive/negative Infinity, and negative zero
- [x] type-preserving process-restart E2E
- [x] explicit size failure above the local 1 MiB non-stream limit
- [ ] persisted `ReadableStream<Uint8Array>`
- [ ] complete Cloudflare `RpcSerializable` surface

Unsupported cycles, functions, symbols, custom-prototype objects, and streams fail
explicitly rather than being stringified or silently buffered.

## REST compatibility facade

The optional local HTTP host exposes a thin facade over the same runtime used by
the Workers binding and CLI.

- [x] Cloudflare-style success/error envelope
- [x] create instance
- [x] batch create
- [x] get instance
- [x] list instances
- [x] lifecycle status mutation
- [x] send event (the request JSON body is the event payload verbatim)
- [x] restart
- [x] terminate
- [x] delete
- [ ] REST step-output endpoint
- [ ] REST `GET .../subscribe` streaming endpoint

## CLI

- [x] `workflows dev --config wrangler.jsonc`
- [x] `workflows dev` serves default Worker + REST routes
- [x] `--no-http` scheduler-only mode
- [x] `workflows trigger <workflow> --params ...`
- [x] `workflows status <workflow> <instance-id>`
- [x] `workflows event <workflow> <instance-id> <type> --payload ...`
- [x] pause
- [x] resume
- [x] restart
- [x] terminate

## Automated verification oracle

The compatibility date above is backed by `compat/oracle/manifest.json`, which
currently pins Wrangler **4.141.0**, `@cloudflare/workers-types`
**5.20260925.2**, and workerd **1.20260925.2**.

Normal PR/push CI runs `npm run compat:pinned`. It checks the pinned public
API/config contract and then executes unchanged TypeScript probe source under
both Cloudflare `wrangler dev` and `workflows.mbt`. The comparator uses only
observable behavior: terminal status/output/error, stable lifecycle events,
step/attempt behavior, sleep/wait behavior, and rollback order/outcome. Transient
`workflow_running` / `workflow_waiting` transitions are excluded from exact
sequence comparison because local Wrangler may coalesce them for short waits;
Runtime-specific instance IDs, event IDs, timestamps, temporary paths, and
wall-clock timing are excluded.

The initial differential probes are:

- `basic` — `step.do` result and lifecycle
- `retry` — retry/attempt behavior
- `sleep` — durable sleep behavior
- `wait-for-event` — event delivery through `waitForEvent`
- `rollback` — rollback ordering and terminal error behavior
- `entrypoint-ctx` — `this.ctx` presence, method surface, `ctx.exports`
  loopback behavior, and span async-context/end semantics during `run()`

The pinned check also verifies the local host/shim classes still implement
every member the upstream types track (`localSurface` in the drift report), so
a tracked member cannot silently lose its local implementation. The tracked
surfaces are `Workflow`, `WorkflowInstance`, `WorkflowInstanceCreateOptions`,
`WorkflowInstanceSubscribeOptions`, `WorkflowStep`, `WorkflowEntrypoint`, and
`ExecutionContext`.

`compat:pinned` also runs `npm run compat:typecheck` (tsc over
`compat/typecheck/`): a compile-time fixture that consumes the shim
`cloudflare:workers` declarations the way source-compatible Worker code does
— `this.ctx.exports.default.fetch(...)` and typed WorkflowEntrypoint loopback
exports — without casts, via `Cloudflare.GlobalProps.mainModule`
augmentation (the wrangler-generated pattern).

`npm run compat:latest` is intentionally outside required PR CI. The scheduled
`compatibility-latest` workflow resolves current upstream packages, classifies
meaningful surface drift as `added`, `removed`, or `changed`, and runs the same
differential probes against the latest local Wrangler runtime. Reports and raw
traces are retained as Actions artifacts even when a check fails.

`npm run compat:report` renders the current verification summary into
`compat-results/report.md` without replacing the human-maintained compatibility
explanation in this file.

Production Cloudflare is reserved as an optional, credential-gated oracle. The
credential-free local oracle does not claim that local Wrangler/workerd and the
hosted Cloudflare service are identical in every account- or plan-dependent
behavior.

## Known differences

These are intentionally not hidden behind compatibility claims:

1. **ReadableStream step-output persistence** — Cloudflare JavaScript Workflows
   support fresh unlocked `ReadableStream<Uint8Array>` step outputs. The SQLite
   adapter rejects persisted step-result streams until a bounded persisted
   streaming contract is added. This does **not** apply to default Worker HTTP
   responses, which are streamed incrementally by the local HTTP host.
2. **Full RpcSerializable** — the practical structured-value subset above is
   covered, but `workflows.mbt` does not yet claim the complete Workers RPC
   serialization surface.
3. **Account-plan retention defaults** — Cloudflare currently retains finished
   state for the account's plan default when no explicit retention is supplied.
   A local runtime has no Cloudflare account plan, so unspecified retention is
   currently unlimited. Explicit instance and Wrangler retention are supported.
4. **Bare Promise.race / Promise.any replay winner** — Cloudflare itself warns
   that the observed winner can differ from the cached replay winner. The same
   stronger guarantee is not claimed here; use an outer `step.do` when the
   winner must be durable.
5. **Timeout crash boundary** — per-attempt timeout enforcement currently uses a
   host timer. Retry state is durable once the timeout is recorded, but an
   in-flight timeout deadline itself is not persisted across process death.
6. **Single executor process** — SQLite is safe for the tested single runtime
   process. There is not yet an instance lease preventing two separate scheduler
   processes from racing the same database.
7. **REST streaming** — Workers `WorkflowInstance.subscribe()` is implemented,
   but the Cloudflare REST subscription stream transport is not.
8. **Cloudflare service bindings** — no built-in D1/KV/R2/Queues/AI/Durable
   Objects/Service Binding emulators are bundled.
9. **Workflow placement / concurrency controls** — current Cloudflare
   surfaces expose instance `locationHint` plus Workflow `limits` and
   `concurrency`. The local single-machine runtime does not emulate
   Cloudflare geographic placement or account-level concurrency/limit
   enforcement.
10. **Cross-script Workflow bindings** — Wrangler
    `workflows[].script_name` can reference a Workflow defined by another
    Worker. The local host currently resolves Workflow classes from the
    configured local module only.

## Compatibility claim

The tested P0/P1 surface is sufficient to describe this project as a
**broad Cloudflare Workflows-compatible local runtime** for the documented
2026-09-26 oracle.

The phrase **fully compatible** is deliberately not used. It requires continued
oracle maintenance against upstream API/types changes and a shrinking
Known-differences list.
