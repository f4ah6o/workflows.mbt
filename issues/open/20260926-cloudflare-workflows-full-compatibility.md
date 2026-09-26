# Cloudflare Workflows full-compatibility gaps

Status: open  
Created: 2026-09-26  
Target: `main`

## Goal

Move `workflows.mbt` from the current durable vertical slice to a substantially
stronger drop-in replacement for existing Cloudflare Workflows applications.

The current runtime already satisfies the core acceptance criterion for sequential
workflows:

- existing TypeScript/JavaScript workflow source keeps `cloudflare:workers`
- `WorkflowEntrypoint.run(event, step)`
- `step.do`
- durable replay
- durable `sleep` / `sleepUntil`
- durable retries
- durable `waitForEvent`
- workflow binding create/get
- instance lifecycle operations
- SQLite persistence
- real process SIGKILL/restart E2E
- source-unmodified fixture
- duplicate step-name/count replay
- restart-from-step

Current CI is green at the time this issue is created.

This issue tracks the remaining compatibility work needed before describing the
project as broadly Cloudflare Workflows-compatible rather than a high-compatibility
MVP.

## Compatibility principle

Do not improve compatibility by moving the durable workflow engine into
TypeScript.

Keep the boundary:

```text
Cloudflare-compatible TS/JS source
        |
        v
small compatibility host
        |
        v
MoonBit durable execution kernel
        |
        v
storage / scheduler adapters
```

The TypeScript/JavaScript host may continue to own module loading, transpilation,
Web APIs, callback invocation, and narrow OS/runtime bridges.

Durable state-machine semantics, replay decisions, retry/timer rules, instance
state transitions, and compatibility-critical workflow execution rules should
remain MoonBit-first.

---

## P0 — Parallel durable step semantics

This is currently the largest source-compatibility gap.

Cloudflare workflow source can use normal Promise concurrency patterns around
durable step operations. Current v0.1 intentionally rejects concurrent durable
operations.

Implement and verify compatibility for:

- `Promise.all`
- `Promise.allSettled`
- `Promise.race`
- `Promise.any`
- multiple simultaneously pending `step.do`
- mixtures of `step.do`, `sleep`, and event waits where Cloudflare permits them

### Required design work

The current sequential call-order-derived ordinal model is not sufficient for
general concurrent execution.

Define a deterministic durable identity/order model that survives:

- different promise scheduling order
- process restart
- callback completion reordering
- one branch completing while another suspends
- retries in one branch while another branch completes

Do not rely on incidental Node microtask ordering as durable identity.

### Acceptance

Add source-unmodified fixtures with representative concurrent Cloudflare-style
workflow code.

At minimum:

1. two parallel `step.do` calls both complete
2. one branch retries while another completes
3. restart during `Promise.all` does not rerun already committed callbacks
4. `Promise.race` replay returns the same durable winner
5. duplicate names in concurrent branches remain stable
6. unsupported combinations, if any remain, fail explicitly rather than produce
   incorrect replay

---

## P0 — Serialization / RpcSerializable compatibility

Current persistence intentionally prioritizes JSON-compatible values.

Add compatibility for values commonly accepted by Cloudflare's RPC/workflow
surface.

Prioritize:

- `Date`
- `ArrayBuffer`
- typed arrays
- `Map`
- `Set`
- nested combinations of supported structured values
- error values where relevant
- stream-compatible output design

Then investigate and document the exact current Cloudflare `RpcSerializable`
surface and decide which types are:

- fully supported
- losslessly adapted
- explicitly unsupported

### ReadableStream

Design and implement persisted `ReadableStream<Uint8Array>` behavior only after
the persistence contract is clear.

Do not silently buffer an unbounded stream into memory or stringify unsupported
values.

### Acceptance

Round-trip tests must verify type preservation, not just equivalent JSON output.

Process-restart E2E must cover persisted non-JSON-compatible values.

---

## P0 — Rollback / compensation

Rollback support is currently reserved in schema but not implemented.

Implement Cloudflare-compatible rollback behavior for successful `step.do`
registrations.

Required areas:

- rollback handler registration
- durable rollback registration persistence
- rollback execution ordering
- retry/error semantics for rollback handlers
- process restart during rollback
- terminate-with-rollback behavior
- `rollingBack` instance state
- explicit rollback completion/failure state transitions

Current behavior must continue to reject rollback options explicitly until this is
implemented; never silently ignore rollback handlers.

### Acceptance

1. successful steps register rollback handlers durably
2. termination can initiate rollback
3. rollback survives SIGKILL/restart
4. rollback order matches the current Cloudflare contract
5. already-completed rollback handlers are not rerun after restart
6. failure behavior is compatibility-tested

---

## P1 — Scheduled workflow event compatibility

Implement scheduled-trigger event metadata.

Target:

```ts
event.schedule = {
  cron,
  scheduledTime,
}
```

Required work:

- Wrangler schedule parsing where relevant
- local scheduler representation
- deterministic scheduled instance creation
- missed/restarted scheduler behavior
- compatibility of `event.timestamp` vs `scheduledTime`

Do not conflate durable step timers with workflow-level cron scheduling.

### Acceptance

A source-unmodified scheduled workflow fixture receives Cloudflare-compatible
event shape and survives scheduler/runtime restart.

---

## P1 — WorkflowInstance.subscribe()

Design and implement `WorkflowInstance.subscribe()` without coupling storage to
a single transport.

The internal event/state-change log already provides a useful basis.

Need:

- subscription event model
- status/output/error updates
- terminal completion behavior
- reconnect/resume semantics
- backpressure/cancellation
- CLI/host transport choice

Prefer an internal abstraction that can later back REST/SSE/WebSocket facades.

---

## P1 — Workflow binding semantic parity

Current binding surface includes:

- `create`
- `get`
- `createBatch`
- `deleteBatch`

Remaining compatibility work:

- verify per-workflow instance ID uniqueness semantics
- remove current process-global ID mismatch if Cloudflare scopes IDs differently
- retention options
- batch partial-failure behavior
- exact error shapes/codes where source compatibility depends on them
- current limits and edge cases from official docs/Workers types

Add oracle tests rather than relying only on documentation prose.

---

## P1 — Default Worker handler compatibility

Existing Cloudflare applications may combine workflow classes with a default
Worker export that invokes workflow bindings.

Support representative source such as:

```ts
export default {
  async fetch(request, env) {
    const instance = await env.MY_WORKFLOW.create({
      params: { ... },
    });
    return Response.json(await instance.status());
  },
};
```

The goal is not a full Workers runtime clone.

Provide enough local Worker-host behavior that normal workflow-triggering HTTP
handlers can run without source modification.

### Acceptance

A fixture containing both:

- exported `WorkflowEntrypoint`
- default `fetch` handler using `env.MY_WORKFLOW`

runs unchanged locally.

---

## P1 — Wrangler compatibility expansion

Current config consumption is intentionally narrow.

Expand only where it improves source/config compatibility for Workflows:

- workflow bindings
- scheduled triggers
- variables/secrets injection model
- compatibility flags if they affect workflow execution
- relevant development environment config

Unknown unrelated Cloudflare settings should remain safely ignored unless an
adapter supports them.

Do not turn this project into a full Wrangler clone.

---

## P1 — REST API compatibility facade

Add an optional facade compatible with the current Cloudflare Workflows REST API
for instance operations.

Prioritize endpoints equivalent to:

- create workflow instance
- get/list instance state
- patch instance status/lifecycle
- send event
- restart
- terminate/delete

Keep the REST layer thin over the same MoonBit/runtime semantics used by the JS
binding and CLI.

Do not create separate behavior paths that can drift from the core engine.

---

## P2 — Cloudflare service binding adapters

Full emulation of Cloudflare services is not required for Workflows compatibility,
but real existing projects often access other bindings through `this.env`.

Keep the generic injection mechanism and add optional adapters incrementally.

Candidates:

- D1 -> SQLite/PostgreSQL adapter
- KV -> generic KV adapter
- R2 -> S3-compatible adapter
- Queues -> pluggable queue adapter
- Service Bindings -> local/HTTP adapter

Workers AI and Durable Objects should remain separate efforts unless a concrete
workflow compatibility fixture requires them.

Do not block core Workflows compatibility on full Cloudflare platform emulation.

---

## P2 — State-model fidelity

Internal storage can already represent:

- `queued`
- `running`
- `paused`
- `errored`
- `terminated`
- `complete`
- `waiting`
- `waitingForPause`
- `rollingBack`

Currently `waitingForPause` and `rollingBack` are reserved rather than fully
produced by runtime behavior.

Verify the current Cloudflare state-transition contract and implement:

- pause requested during active execution
- safe transition to `waitingForPause`
- rollback transition to `rollingBack`
- lifecycle operation validity by state
- restart/terminate/delete behavior from every state

Add a state-transition compatibility table and negative tests.

---

## P2 — Error compatibility

Audit error behavior for:

- duplicate instance IDs
- unknown instance
- invalid restart target
- serialization failure
- invalid event type
- timeout
- retry exhaustion
- `NonRetryableError`
- unsupported rollback
- concurrent operations
- invalid lifecycle transition

Where Cloudflare exposes stable names/codes/shapes, mirror them.

Do not sacrifice clear local errors for undocumented behavior; document uncertain
areas explicitly.

---

## P2 — Timeout semantics audit

Current per-attempt timeout uses host-side Promise timeout behavior.

Verify Cloudflare semantics for:

- callback still running after timeout
- process crash around timeout deadline
- timeout vs retry ordering
- dynamic retry delay after timeout
- long timeout persistence
- timer granularity

Move any compatibility-critical timeout decision into durable persisted state if
the current host-only behavior can diverge after restart.

---

## P2 — Storage abstraction hardening

SQLite is the v0.1 reference backend.

Before adding PostgreSQL, ensure the storage abstraction is defined around durable
workflow operations rather than SQL-shaped CRUD.

Review atomic boundaries for:

- step success commit
- retry scheduling
- event consume + step completion
- restart-from-step invalidation
- rollback registration/execution
- concurrent branch completion

Then add PostgreSQL only as a proof that the abstraction is not SQLite-specific.

---

## P2 — Multi-process / lease boundary

Do not implement a distributed scheduler yet, but make single-machine semantics
safe if more than one runtime process accidentally points at the same database.

Add a lease/claim model for runnable instances before claiming multi-process
support.

Required properties:

- one active executor per instance/epoch
- stale lease recovery
- crash-safe release/expiry
- no double callback execution caused solely by two schedulers racing

This is distinct from the documented at-least-once external side-effect window.

---

## Compatibility oracle maintenance

Keep `compat/cloudflare/VERSION.md` current.

For each compatibility milestone:

1. check current Cloudflare Workflows docs
2. check current Workers TypeScript definitions/SDK surface when available
3. update oracle date
4. add small clean-room semantic fixtures
5. avoid copying substantial Cloudflare implementation/source
6. update `COMPATIBILITY.md` only after tests exist

A checkbox should mean tested behavior, not intended behavior.

---

## Required regression suite

Every compatibility expansion must keep the existing core suite green:

- MoonBit check/build
- MoonBit tests
- compatibility host tests
- `CLOUDFLARE_SOURCE_UNMODIFIED_OK`
- durable replay
- real process SIGKILL/restart
- durable sleep deadline preservation
- retry persistence
- waitForEvent restart
- event-before-wait buffering
- duplicate step-name/count
- instance output
- restart-from-step

Add new suites for:

- parallel semantics
- structured/RpcSerializable values
- rollback
- schedule metadata
- subscribe
- default Worker handler
- REST facade

---

## Definition of done for "broad drop-in compatibility"

Do not describe the project as fully compatible merely because this issue is
closed.

This issue can be closed when:

1. the P0 and P1 items above are implemented or explicitly documented as
   intentionally unsupported based on verified upstream behavior
2. representative existing Cloudflare Workflow source fixtures run without
   editing workflow source
3. concurrent durable semantics are no longer a major compatibility hole
4. non-JSON structured values cover the practical current Cloudflare surface
5. rollback semantics are durable and restart-safe
6. scheduled workflows and `subscribe()` are covered
7. default Worker handler + workflow binding usage works unchanged for the common
   case
8. REST compatibility exists for core instance operations
9. all compatibility claims are backed by tests
10. CI is green

Even after closure, reserve the phrase **fully compatible** for a separately
maintained compatibility statement with an explicit upstream version/date and a
known-differences list.
