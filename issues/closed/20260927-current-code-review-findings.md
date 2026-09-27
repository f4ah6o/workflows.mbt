# Current code review follow-ups: retention, REST events, inbound Worker streaming

Status: closed
Created: 2026-09-27  
Target: `main`  
Triage: correctness follow-up before optional platform hardening

## Review scope

This issue records concrete findings from a review of current `main` after PRs
#1–#3. These are narrower than the dependency-insurance roadmap and the optional
post-compatibility hardening backlog: each finding affects behavior already
described as implemented or broadly compatible.

## P1 — apply Workflow `default_retention` to scheduled instances

### Finding

`WorkflowRuntime.createInstance()` resolves the Workflow's
`default_retention` and passes parsed success/error retention to storage.

Scheduled creation takes a different path:

`enqueueSchedules()` -> `SQLiteStorage.claimScheduledInstance()` ->
`SQLiteStorage.createInstance()`.

That path does not pass retention, so automatically scheduled instances store
NULL success/error retention even when their Workflow binding has
`default_retention`.

Cloudflare documents `default_retention` as the default retention for Workflow
instances when per-instance retention is not supplied, and cron schedules create
Workflow instances automatically.

References:

- https://developers.cloudflare.com/workflows/build/workers-api/#default-instance-retention
- https://developers.cloudflare.com/workflows/build/trigger-workflows/

### Acceptance

- add a scheduled fixture that also defines a short `default_retention`
- verify a completed scheduled instance receives and obeys success retention
- verify an errored scheduled instance receives and obeys error retention
- preserve explicit per-instance retention precedence for normal binding/REST
  creation
- ensure schedule replay/idempotence remains unchanged
- add upstream differential coverage when the oracle can exercise the same
  schedule behavior reliably

## P1 — REST event endpoint must treat the JSON body as the event payload

### Finding

The REST adapter currently does:

```js
const body = await readJson(request);
await instance.sendEvent({
  type: eventType,
  payload: body.payload ?? body,
});
```

Cloudflare's REST endpoint defines the request body itself as `unknown`; it is
the event payload. Special-casing a top-level `payload` property changes valid
payloads. For example, `{"payload": null}` cannot round-trip exactly.

The current E2E also posts `{"payload":{"approved":true}}`, so it validates the
local wrapper rather than Cloudflare's REST shape.

Reference:

- https://developers.cloudflare.com/api/resources/workflows/subresources/instances/subresources/events/methods/create/

### Acceptance

- pass the parsed REST request body directly as `sendEvent(...).payload`
- update the REST E2E to post `{"approved":true}` and observe that exact payload
- add a regression case where the payload itself contains a `payload` key,
  including `{"payload":null}`
- retain existing event-type validation and lifecycle behavior
- add this endpoint to the differential catalog when practical

## P2 — stream inbound default-Worker request bodies

### Finding

`host/server.mjs:nodeRequest()` currently reads every request chunk into an
array and `Buffer.concat()`s the complete body before constructing the Web
`Request`.

Cloudflare Worker `Request.body` is a `ReadableStream`. Full pre-buffering
removes streaming/backpressure behavior, delays Worker execution until upload
EOF, and makes large request memory usage proportional to the whole body.

References:

- https://developers.cloudflare.com/workers/runtime-apis/request/
- https://developers.cloudflare.com/workers/runtime-apis/streams/

### Acceptance

- adapt Node's incoming request body to a Web `ReadableStream` for non-GET/HEAD
  requests; use the Node `Request` streaming options required by the supported
  Node version
- preserve backpressure and cancellation instead of accumulating the full body
- add an E2E where the Worker observes the first request chunk before the client
  finishes sending the second chunk
- keep GET/HEAD body handling standards-compliant
- retain the existing response-streaming, `waitUntil`, and multi-`Set-Cookie`
  regressions


## P1 — restore persisted ordinals for `sleepUntil()` replay

### Finding

Durable step ordinals are used for replay ordering, restart-from-step invalidation,
and rollback ordering. The replay paths for `step.do()`, `step.sleep()`, and
`step.waitForEvent()` adopt a previously persisted ordinal when an earlier
callback was skipped during replay.

`ExecutionContext.sleepUntil()` looks up the persisted step but does not call
`adoptPersistedOrdinal(identity, existing)`.

That makes `sleepUntil()` the odd path out. After replay skips nested durable
work inside an already-completed callback, a waiting/completed `sleepUntil`
can leave the in-memory ordinal counter behind its stored ordinal. A later newly
created step can then receive an ordinal that is already used by the persisted
sleep, weakening ordering assumptions used by restart/rollback logic.

There is currently no `sleepUntil` E2E fixture, while the compatibility matrix
marks both Date and Unix-millisecond `sleepUntil` forms implemented.

### Acceptance

- call `adoptPersistedOrdinal(identity, existing)` in the `sleepUntil()`
  replay path, matching `sleep()` and `waitForEvent()`
- add Date and Unix-millisecond `sleepUntil` regression coverage
- add a replay fixture where an earlier completed callback originally created a
  nested durable operation, then a persisted `sleepUntil` is replayed, followed
  by a newly created step
- assert persisted ordinals remain strictly ordered for that execution
- verify restart-from-step and rollback ordering remain correct

## P1 — expose the Cloudflare `WorkflowEntrypoint.ctx` contract

### Finding

The pinned upstream API snapshot already records `ctx` as a
`WorkflowEntrypoint` member. Current Cloudflare Workers types define
`WorkflowEntrypoint` with a protected `ctx: ExecutionContext` constructor
property.

The local shim currently discards the constructor's first argument:

```js
export class WorkflowEntrypoint {
  constructor(_ctx, env) {
    this.env = env ?? {};
  }
}
```

The runtime also instantiates Workflow classes with a bare `{}` for that
argument. A Workflow source that uses the documented context contract through
`this.ctx` therefore sees `undefined` locally even though the oracle knows
the member exists.

References:

- https://github.com/cloudflare/workerd/blob/main/types/defines/rpc.d.ts
- https://developers.cloudflare.com/workers/runtime-apis/context/

### Acceptance

- define the local Workflow entrypoint context contract explicitly
- preserve `this.ctx` on the compatibility class
- provide the context methods that are valid for a Workflow invocation, with
  behavior matching the supported Cloudflare surface
- add a source-unmodified fixture that accesses `this.ctx`
- make the compatibility oracle verify implementation/probe evidence for tracked
  members, not only that the upstream member still exists


## P1 — match Cloudflare numeric weekday semantics in Workflow schedules

### Finding

Cloudflare's five-field cron syntax defines numeric weekdays as
`1 = Sunday ... 7 = Saturday`.

`host/cron.mjs` currently uses the JavaScript `Date#getUTCDay()` numbering
directly (`0 = Sunday ... 6 = Saturday`) and only aliases parsed numeric `7`
to `0`. As a result, a Cloudflare schedule such as `0 17 * * 1` is Sunday
upstream but Monday locally.

The existing host test currently encodes the local numbering by asserting that
numeric `6` and `SAT` are equivalent. That should be corrected rather than
preserved.

Cloudflare reference:

- https://developers.cloudflare.com/workers/configuration/cron-triggers/

### Acceptance

- interpret numeric weekdays exactly as Cloudflare: `1=SUN` through
  `7=SAT`
- either reject numeric `0` or match the upstream parser's observed behavior;
  do not silently treat it as the canonical Sunday value
- keep named weekdays (`SUN`...`SAT`) working
- add explicit tests for `1 == SUN`, `2 == MON`, and `7 == SAT`
- add a weekday range test equivalent to Cloudflare's documented
  `MON-FRI` / `2-6`
- include numeric weekday schedules in the upstream differential catalog

## Validation

Run and record:

```bash
npm run test
npm run compat:pinned
```

Also run the focused new E2E cases above. If a new differential probe is added,
verify both pinned and latest oracle modes separately.

A test that was not executed must remain reported as not executed.

## Resolution

Implemented on 2026-09-27:

- Scheduled `default_retention`: `WorkflowRuntime.enqueueSchedules()` now
  resolves the Workflow's retention via a shared `resolveRetention()` and
  `SQLiteStorage.claimScheduledInstance()` forwards it to `createInstance()`.
  E2E: `scheduled-retained` and `scheduled-error` fixtures
  (`default_retention` 40ms/60ms) assert completed and errored scheduled
  instances expire on their retention while the un-retained instance from the
  same firing remains; per-instance retention precedence is unchanged;
  `scheduled_runs` idempotence is unchanged (re-firing the same minute is a
  no-op).
- REST event payload: `handleWorkflowRest()` passes the parsed JSON body as the
  event payload verbatim. E2E covers `{"approved": true}` and a literal
  `{"payload": null}` body round-trip; event-type validation is retained.
- Inbound request streaming: `nodeRequest()` builds the Web `Request` from
  `Readable.toWeb(req)` with `duplex: "half"` for non-GET/HEAD methods. E2E: the
  `/first-chunk` fixture returns the first uploaded chunk before the client
  sends the rest of the body, which a buffering host cannot do. GET/HEAD remain
  bodiless; response streaming, `waitUntil`, and `Set-Cookie` regressions still
  pass.
- `sleepUntil()` ordinals: `sleepUntil()` calls
  `adoptPersistedOrdinal(identity, step)` like `sleep()`/`waitForEvent()`. E2E:
  `sleep-until` fixture exercises both `Date` and Unix-ms arguments inside a
  run whose completed `outer` callback created the nested `nested` step; the
  persisted ordinal order `outer, nested, until-date, until-ms, after-sleep` is
  strictly 1..5, and restart-from-step leaves it unchanged.
- `WorkflowEntrypoint.ctx`: the `cloudflare:workers` shim stores
  `this.ctx`/`this.env`; the local `WorkerExecutionContext`
  (`host/execution-context.mjs`) models the pinned `ExecutionContext` surface:
  `waitUntil()` (registered with the runtime's background-task set and drained
  by `runtime.close()` before SQLite closes — the returned result never waits
  on them), `passThroughOnException()` (no-op), `props`/`exports` (objects;
  `exports` carries the module `default`), `tracing` (no-op `Span` + active-span
  tracking), `abort()` (terminates the Workflow invocation's instance and
  unwinds `run()`), and `cache`/`access` present as `undefined` (optional
  upstream). `runInstance`, `runRollbackInstance`, and the default Worker
  `fetch` handler receive it. E2E: `entrypoint-ctx` asserts presence/typeofs
  and `waitUntil` delivery from unmodified source; `wait-until-ctx` asserts a
  delayed `waitUntil` continuation still runs to completion before
  `runtime.close()` resolves. The `entrypoint-ctx` differential probe reports
  the full surface and matches upstream exactly under `wrangler dev`. The
  pinned oracle now also verifies the local host/shim classes implement every
  tracked upstream member — `ExecutionContext` included (`localSurface` in
  `compat-results/drift-*.json`), so a tracked member cannot silently lose its
  implementation.
- Cron weekday semantics: `host/cron.mjs` interprets numeric weekdays as
  Cloudflare's `1=SUN..7=SAT` (converted to JS `getUTCDay()` numbering via
  `n - 1`); numeric `0` is rejected as an out-of-range value rather than
  aliased to Sunday. Named weekdays and ranges are unchanged; the host test
  that encoded the old numbering was corrected, and new tests assert
  `1==SUN`, `2==MON`, `7==SAT`, `2-6 == MON-FRI`, and that `0`/`0-6` throw.

Validation results (2026-09-27, this checkout):

- `npm run test`: PASS — moon check PASS, moon JS kernel build PASS, moon
  tests PASS, host tests PASS, durable process E2E PASS (39/39).
- `npm run compat:pinned`: PASS — contract check `pass: true` with empty drift;
  differential `pass: true` with zero differences across six probes including
  the new `entrypoint-ctx`.
- `npm run compat:latest`: PASS — required because the `entrypoint-ctx` probe
  was added to the differential catalog; both modes verified separately.

Not executed: upstream differential coverage for cron schedules, the REST
events endpoint, and the inbound-streaming endpoint — local `wrangler dev` does
not serve the Cloudflare Workflows REST API or expose inbound-body timing, and
cron schedules require minute-scale wall-clock waits. Those remain local-E2E
covered only; tracked by the dependency-insurance roadmap's "when practical"
upstream-coverage items.
