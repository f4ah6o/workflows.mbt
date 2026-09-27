# Current code review follow-ups: retention, REST events, inbound Worker streaming

Status: open  
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

## Validation

Run and record:

```bash
npm run test
npm run compat:pinned
```

Also run the focused new E2E cases above. If a new differential probe is added,
verify both pinned and latest oracle modes separately.

A test that was not executed must remain reported as not executed.
