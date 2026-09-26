# Cloudflare compatibility oracle

Cloudflare Workflows API checked: **2026-09-26**

This file records the upstream contract used by the compatibility fixtures. It is
not a claim that every Cloudflare Workers feature is emulated.

## Upstream references

- Workers API:
  https://developers.cloudflare.com/workflows/build/workers-api/
- Sleeping and retrying:
  https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- Step context:
  https://developers.cloudflare.com/workflows/build/step-context/
- Events and parameters:
  https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Rules of Workflows:
  https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Trigger Workflows / instance lifecycle:
  https://developers.cloudflare.com/workflows/build/trigger-workflows/
- Subscribe to instance events:
  https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/
- Wrangler configuration:
  https://developers.cloudflare.com/workers/wrangler/configuration/
- Workflows limits:
  https://developers.cloudflare.com/workflows/reference/limits/
- Workflows pricing / retention:
  https://developers.cloudflare.com/workflows/reference/pricing/
- Workflows REST API:
  https://developers.cloudflare.com/api/resources/workflows/

## Contract pinned by tests

### Steps and retries

- default retry limit: 5 retries (6 attempts total)
- default retry delay: 10 seconds
- default retry backoff: exponential
- default per-attempt timeout: 10 minutes
- configured retry limit maximum: 10,000
- `WorkflowStepContext.attempt` and step count are 1-origin
- `WorkflowStepContext.config` exposes resolved defaults
- `waitForEvent` default timeout: 24 hours
- events may arrive before a matching `waitForEvent`
- `sensitive: "output"` redacts subscription step output while preserving the
  durable result used by Workflow code

### Promise concurrency

Cloudflare permits durable step promises in normal Promise combinators. The
oracle covers `all`, `allSettled`, `race`, and `any`.

Cloudflare explicitly warns that a bare `Promise.race` or `Promise.any` can
observe a different winner than the value that is cached during replay. The
documented durable pattern is to wrap the combinator in an outer `step.do`;
`workflows.mbt` has a restart fixture for that pattern.

### Rollback

- rollback handlers are registered on `step.do`
- terminal Workflow failure automatically initiates registered rollback
- `terminate({ rollback: true })` explicitly initiates rollback
- rollback runs in reverse step-start order
- the failed registered step may itself roll back
- a failed step receives `output === undefined`
- rollback receives the original Workflow-causing error
- rollback supports retry, timeout, and non-retryable behavior
- Workers `status()` reports `running` while rollback is active

### Schedules

- `workflows[].schedules` accepts UTC cron expressions
- named weekdays/months are accepted, including patterns such as `MON-FRI`
- scheduled event metadata is `event.schedule = { cron, scheduledTime }`
- each firing creates a distinct Workflow instance

### Workflow instances

- custom instance IDs must be unique **within the Workflow**
- `createBatch` is idempotent for already-existing IDs
- per-instance retention overrides Workflow `default_retention`
- success retention applies to successful and terminated instances
- error retention applies to errored instances
- `resume()` on an instance that is not paused has no effect

Cloudflare account-plan default retention is not used as a local default because
the local runtime has no Cloudflare plan context. Explicit retention remains
compatible.

### Subscriptions

The September 15, 2026 subscription API is part of this oracle.

- subscriptions replay retained history before waiting for new events
- `filter` selects event types
- `cursor` resumes after a prior event
- the event model includes workflow, step, attempt, sleep, wait, and rollback
  events
- terminal events end the subscription
- sensitive step output is redacted

The Workers `WorkflowInstance.subscribe()` surface is covered. The REST
streaming subscribe transport is a separate remaining adapter.

### Serialization

Cloudflare accepts structured-clone-style step results and supports
`ReadableStream<Uint8Array>` for larger JavaScript step output.

The local oracle tests type-preserving persistence for Date, Map, Set,
ArrayBuffer/DataView, typed arrays, BigInt, RegExp, Error, nested structured
values, and process restart. Streams remain an explicit known difference.

## Clean-room policy

This repository implements observed/documented behavior and small semantic
fixtures. Substantial Cloudflare implementation source is not copied into the
runtime.
