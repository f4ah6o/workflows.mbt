# Cloudflare dependency insurance and compatibility maintenance

Status: open  
Created: 2026-09-26  
Target: `main`

## Purpose

`workflows.mbt` is not intended to compete with Cloudflare Workflows or replace
Cloudflare as the normal production platform.

The project exists to make Cloudflare Workflows safer to depend on by preserving
an independently runnable, source-compatible escape path.

The operating assumption is:

```text
normal operation
  -> deploy and run on Cloudflare Workflows

continuously
  -> verify the same workflow source against workflows.mbt

Cloudflare outage / unacceptable platform change / strategic exit
  -> switch new workflow execution to workflows.mbt without rewriting workflow source
```

The target is therefore not "clone the whole Cloudflare platform".

The target is:

1. keep existing Cloudflare Workflows source portable
2. continuously detect compatibility drift before the fallback is needed
3. keep a fallback runtime that can actually be started in an emergency
4. document clearly what state and platform features do not migrate

## Current review result

As of the 2026-09-26 compatibility review, the repository already has a strong
foundation for this goal.

Implemented and repository-tested areas include:

- unchanged `cloudflare:workers` / `cloudflare:workflows` imports
- `WorkflowEntrypoint` and workflow event basics
- `step.do`, retry, timeout, sleep, `sleepUntil`, and `waitForEvent`
- Promise concurrency including `all`, `allSettled`, `race`, and `any`
- durable replay and real SIGKILL/restart E2E
- rollback / compensation including restart recovery
- Workflow binding create/get/batch operations
- lifecycle operations
- schedules
- `WorkflowInstance.subscribe()`
- practical structured serialization
- default Worker `fetch`, `ctx.waitUntil()`, streamed HTTP responses, and
  multiple `Set-Cookie` response headers
- SQLite durable storage
- core REST facade

The repository also now contains a continuous compatibility oracle:

- pinned Wrangler / Workers types / workerd contract checking
- required pinned differential probes in normal CI
- a separate scheduled/manual latest-upstream compatibility workflow
- normalized observable-trace comparison between Cloudflare `wrangler dev`
  and `workflows.mbt`
- machine-readable compatibility artifacts and generated reports

The current claim should remain "broad Cloudflare Workflows-compatible local
runtime", not "fully compatible".

## Compatibility maintenance principle

Compatibility must be treated as an actively maintained contract, not a static
feature checklist.

Three distinct confidence levels should be visible for every important surface:

1. **implemented** — code exists in workflows.mbt
2. **repository-tested** — workflows.mbt has regression/E2E coverage
3. **upstream-differential-verified** — the same source/behavior was compared
   against current Cloudflare behavior

Do not collapse these into one checkbox.

A repository-owned test proves regression stability. It does not by itself prove
Cloudflare compatibility.

## P0 — Expand semantic differential coverage

The current differential oracle is directionally correct but still narrow.

At review time the direct upstream differential probes cover:

- basic `step.do`
- retry
- sleep
- `waitForEvent`
- rollback

Expand this into a maintained semantic probe catalog covering the compatibility
matrix.

Prioritize:

### Lifecycle

- pause
- pause during active execution / `waitingForPause`
- resume
- restart
- restart from step
- terminate
- terminate with rollback
- delete
- self-delete

### Binding behavior

- create
- get
- createBatch
- deleteBatch
- duplicate IDs
- workflow-scoped ID semantics
- retention behavior

### Promise semantics

- `Promise.all`
- `Promise.allSettled`
- `Promise.race`
- `Promise.any`
- retry in one concurrent branch
- durable operation mixed with sleep
- durable operation mixed with event wait
- wrapped durable race winner behavior

### Subscription semantics

- lifecycle events
- step events
- attempt/retry events
- sleep/wait events
- rollback events
- cursor resume
- event filters
- terminal completion
- sensitive output redaction

### Serialization

- Date
- BigInt
- RegExp
- Map
- Set
- ArrayBuffer
- DataView
- typed arrays
- Error
- nested structured values
- unsupported/cyclic values
- size limits

### Schedules

- cron parsing
- scheduled event metadata
- duplicate/restart firing behavior
- scheduler restart idempotence

### Worker HTTP compatibility

- default `fetch`
- workflow binding use through `env`
- `ctx.waitUntil()`
- streamed Response body
- multiple Set-Cookie headers

### Acceptance

For each important compatibility row, it should be possible to tell whether it
is:

- only locally tested
- pinned-upstream differential verified
- latest-upstream differential verified
- production-Cloudflare verified

## P0 — Broaden the API/type drift oracle

The current API snapshot tracks important top-level Workflow declarations, but it
does not yet guarantee every compatibility-sensitive nested type.

Add tracked shape/signature coverage for at least:

- `WorkflowEvent`
- `WorkflowStepContext`
- resolved step configuration types
- retry/delay types
- rollback context and rollback options
- instance restart options
- terminate options
- batch result types
- subscription event payload shapes
- `NonRetryableError`
- relevant serialization/RPC types

For discriminated event unions, track field shape as well as the event type name.

A newly added event field, changed callback shape, or changed option contract must
not be invisible merely because the top-level member name stayed the same.

## P0 — Treat semantic drift separately from type drift

Cloudflare behavior can change without a useful TypeScript or Wrangler schema
change.

Examples include:

- defaults
- retention policy
- lifecycle behavior
- timing/retry semantics
- service-side validation
- event ordering
- error behavior

The compatibility system must therefore keep both:

```text
contract drift
  + semantic differential probes
```

Do not consider a clean type/schema comparison sufficient evidence that the
fallback remains compatible.

## P1 — Add a hosted Cloudflare canary oracle

Local `wrangler dev` / workerd is an excellent credential-free default oracle,
but it is not necessarily identical to the hosted Cloudflare service.

Add an optional credential-gated production canary workflow.

Recommended shape:

```text
small disposable Cloudflare Workflow deployment
        |
        v
run a bounded semantic probe catalog
        |
        +------ same probe source ------+
        |                               |
 hosted Cloudflare                workflows.mbt
        |                               |
        +------ normalized traces ------+
                        |
                       diff
```

Run this less frequently than the credential-free oracle, for example weekly or
on compatibility-sensitive changes.

Requirements:

- use an isolated test Worker/Workflow
- no production application data
- bounded cost
- deterministic cleanup
- retain normalized traces as artifacts
- distinguish hosted-oracle failures from local Wrangler drift

The purpose is not to certify every Cloudflare service. It is to prevent the
escape path from silently drifting from the actual hosted Workflows service.

## P1 — Make compatibility drift actionable

A red scheduled Action is easy to miss.

When the latest or hosted oracle detects a meaningful compatibility change,
produce a durable actionable record containing:

- checked upstream versions
- compatibility date
- added / removed / changed contract surface
- failed semantic probes
- normalized expected vs actual trace
- link to the Actions run/artifacts
- whether the failure is pinned, latest-local, or hosted-production

Prefer automatic creation or update of one GitHub issue per upstream drift event,
with deduplication so the same drift does not create daily issue spam.

Do not automatically modify compatibility claims merely because upstream changed.
Require a verified implementation/test update before claiming support.

## P1 — Make compatibility status machine-readable

Keep the human `COMPATIBILITY.md`, but introduce or extend a machine-readable
matrix that can represent per capability:

- implemented
- repository_tested
- pinned_differential
- latest_differential
- hosted_differential
- intentionally_unsupported
- last_verified_at
- upstream versions/date
- notes / known difference

Generate the human summary/report from this data where practical.

The matrix must make it impossible to mistake a repository-only test for upstream
differential verification.

## P1 — Define the fallback operational contract

Source compatibility is only one half of dependency insurance.

Document exactly what happens during a real fallback.

The initial supported disaster-recovery model should be conservative:

```text
Cloudflare unavailable / unacceptable
        |
        +--> route NEW workflow invocations to workflows.mbt
        |
        +--> reconcile already-running Cloudflare instances separately
```

Do not imply that in-flight Cloudflare instance state is portable unless an
explicit tested migration mechanism exists.

Document:

- what can switch immediately
- what cannot switch
- treatment of workflows currently sleeping/retrying/waiting
- external-side-effect idempotency requirements
- event replay/re-delivery expectations
- instance ID strategy during fallback
- restoration / return-to-Cloudflare procedure
- reconciliation responsibilities

A clear non-guarantee is better than an untested state-migration claim.

## P1 — Add a regular fallback drill

The escape path must be exercised before it is needed.

Add a small representative Cloudflare Workflow application used as a drill:

1. run it through Cloudflare-compatible configuration
2. run it normally through the Cloudflare oracle
3. switch execution to workflows.mbt
4. do not edit the workflow source
5. verify expected observable behavior
6. verify restart from persisted local state
7. record the result

Run the drill periodically and after compatibility-boundary changes.

The primary success criterion is:

> A representative Cloudflare Workflow can be moved to the fallback runtime
> without modifying its workflow source.

## P1 — Ship an immutable emergency artifact

Avoid discovering build/toolchain problems during an outage.

Produce a reproducible fallback artifact that can be prepared in advance.

At minimum:

- commit a dependency lockfile
- use deterministic dependency installation in CI
- pin the MoonBit toolchain used for release verification
- create a versioned GitHub Release and/or OCI image
- include the compatibility/oracle date in release metadata
- include the known-differences summary
- verify the artifact by actually running the fallback drill from it

The emergency path should not require "install whatever is latest today" before
it can start.

## P2 — Clarify project positioning in README

The README should make the product intent explicit.

Recommended framing:

> A compatibility safety net for Cloudflare Workflows. Use Cloudflare normally;
> keep workflow source portable and continuously verified against an independent
> fallback runtime.

Explicit non-goals:

- competing with Cloudflare Workflows
- cloning the whole Workers platform
- reproducing Cloudflare global/distributed infrastructure
- bundling every D1/KV/R2/Queues/AI/Durable Objects emulator into core
- claiming transparent migration of in-flight Cloudflare state

This framing should guide future scope decisions.

## Known differences that remain acceptable if explicit

The fallback can remain useful without eliminating every Cloudflare difference.

Current important examples include:

- persisted `ReadableStream<Uint8Array>` step output
- complete `RpcSerializable` universe
- Cloudflare account-plan default retention behavior
- timeout crash-boundary differences
- multi-process executor lease/claim
- REST subscription streaming transport
- Cloudflare service-binding emulators
- geographic placement / account-level limits / concurrency
- cross-script Workflow bindings

These should remain visible and tested where possible.

Do not add platform emulation merely to reduce the count of known differences.
Only close a difference when it materially improves the dependency-insurance
use case.

## Definition of done

This issue can be closed when all of the following are true:

1. the project positioning clearly states dependency insurance / fallback rather
   than Cloudflare replacement
2. the compatibility matrix distinguishes implementation, repository test, and
   upstream differential verification
3. the semantic differential catalog covers the major Workflow lifecycle,
   binding, step, subscription, schedule, serialization, and Worker-host surfaces
4. API/type drift tracking covers compatibility-sensitive nested types and event
   payload shapes
5. latest upstream drift runs automatically and produces durable actionable
   reports
6. a hosted Cloudflare canary exists or an explicit documented decision explains
   why it is not required
7. a representative source-unmodified fallback drill exists and is run
   periodically
8. an immutable/reproducible emergency artifact can be prepared in advance
9. the disaster-recovery contract explicitly covers new invocations vs in-flight
   Cloudflare instances
10. compatibility claims remain version/date scoped and known differences remain
    explicit

## Non-goal for closure

Closure does not mean "fully Cloudflare compatible".

It means the project provides a maintained, continuously tested escape path that
makes normal dependency on Cloudflare Workflows materially safer.
