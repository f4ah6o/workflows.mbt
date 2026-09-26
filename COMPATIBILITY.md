# Cloudflare Workflows compatibility

Compatibility oracle date: **2026-09-26**.

This matrix describes implemented behavior, not intended future behavior.

## WorkflowEntrypoint / event

- [x] `WorkflowEntrypoint.run(event, step)`
- [x] `this.env` injection
- [x] `event.payload`
- [x] `event.timestamp`
- [x] `event.instanceId`
- [x] `event.workflowName`
- [ ] scheduled-trigger `event.schedule`

## WorkflowStep

- [x] `step.do(name, callback)`
- [x] `step.do(name, config, callback)`
- [x] retry defaults: 5 retries / 10s / exponential
- [x] static constant / linear / exponential retry delay
- [x] dynamic `WorkflowDelayFunction`
- [x] per-attempt timeout
- [x] step context `{ step: { name, count }, attempt, config }`
- [x] `NonRetryableError`
- [x] `step.sleep(name, milliseconds)`
- [x] `step.sleep(name, humanDuration)`
- [x] `step.sleepUntil(name, Date)`
- [x] `step.sleepUntil(name, unixMilliseconds)`
- [x] `step.waitForEvent(name, { type, timeout })`
- [x] 24-hour default event timeout
- [x] events buffered before the wait is reached
- [ ] rollback handlers (explicit unsupported error; never silently ignored)
- [ ] persisted stream output / full RpcSerializable surface
- [ ] Cloudflare parallel Promise semantics (`all/race/any/allSettled`)

Parallel step calls are a v0.1 non-goal. The runtime is single-instance/
single-step-at-a-time and should reject concurrent durable step operations rather
than claim Cloudflare parallel semantics.

## Step identity / replay

- [x] identity includes instance, type, name, and 1-origin count
- [x] completed callback outputs replay without callback invocation
- [x] duplicate same-name steps in loops remain distinct
- [x] process restart replays `run()` from the beginning
- [x] durable retry timers
- [x] durable sleep deadlines
- [x] durable event queue
- [x] real-process SIGKILL/restart E2E

External callback effects are at-least-once. Exactly-once side effects are not
claimed.

## Workflow binding

- [x] `create`
- [x] `get`
- [x] `createBatch`
- [x] `deleteBatch`
- [ ] per-workflow (rather than process-global) duplicate instance-ID namespace
- [ ] retention options
- [ ] default Worker HTTP handler emulation

## WorkflowInstance

- [x] `id`
- [x] `status()`
- [x] `pause()`
- [x] `resume()`
- [x] `restart()`
- [x] `restart({ from: { name, count, type } })`
- [x] `terminate()`
- [x] `delete()`
- [x] `sendEvent()`
- [ ] rollback-on-terminate
- [ ] `subscribe()`

Internal storage can represent:

- `queued`
- `running`
- `paused`
- `errored`
- `terminated`
- `complete`
- `waiting`
- `waitingForPause`
- `rollingBack`

`waitingForPause` and `rollingBack` are reserved but not produced by the v0.1
executor.

## Configuration / host

- [x] source keeps `cloudflare:workers` unchanged
- [x] `cloudflare:workflows` resolver for `NonRetryableError`
- [x] TypeScript transpilation via esbuild
- [x] `wrangler.jsonc` `main`
- [x] `workflows[].name`
- [x] `workflows[].binding`
- [x] `workflows[].class_name`
- [x] unknown Wrangler fields ignored without source/config rewriting
- [x] separate `workflows.mbt.json` SQLite path override
- [x] native Node Web APIs including `fetch`, `Request`, `Response`, URL
- [ ] Cloudflare D1/KV/R2/Queues/AI/Durable Objects/Service Bindings emulation
- [ ] full Wrangler clone

## Persistence

- [x] SQLite default backend, WAL mode
- [x] workflows
- [x] instances
- [x] steps
- [x] attempts
- [x] timers
- [x] events
- [x] rollback registration schema reserved for future implementation
- [x] execution event log
- [x] SQL isolated behind the SQLite storage adapter
- [ ] PostgreSQL adapter
- [ ] multi-node leases / scheduler

## Serialization

- [x] JSON-compatible primitives, arrays, and plain objects
- [x] side-effect-only `step.do` callbacks returning top-level `undefined`
- [ ] Date / Map / Set / ArrayBuffer compatibility
- [ ] `ReadableStream<Uint8Array>` persistence
- [ ] full RpcSerializable behavior

Unsupported nested values fail with an explicit serialization error; they are
never silently stringified.

## CLI

- [x] `workflows dev --config wrangler.jsonc`
- [x] `workflows trigger <workflow> --params ...`
- [x] `workflows status <workflow> <instance-id>`
- [x] `workflows event <workflow> <instance-id> <type> --payload ...`
- [x] pause
- [x] resume
- [x] restart
- [x] terminate
- [ ] Cloudflare Workflows REST API facade
