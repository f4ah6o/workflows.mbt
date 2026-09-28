# Cloudflare dependency insurance and compatibility maintenance

Status: closed  
Created: 2026-09-26  
Closed: 2026-09-28  
Target: `main`



## Triage — 2026-09-27

This remains the strategic dependency-insurance roadmap. It should not absorb
small correctness defects simply because they affect compatibility.

The current-main review found three focused follow-ups, tracked in
`20260927-current-code-review-findings.md`:

- scheduled instances bypass Workflow `default_retention`
- the REST event endpoint unwraps a top-level `payload` key instead of treating
  the request body as the payload
- inbound default-Worker request bodies are fully buffered rather than streamed

The first two are correctness gaps in surfaces already described as implemented;
fix them before counting those surfaces as stronger compatibility evidence. The
third is HTTP-fidelity hardening and should gain an explicit streaming
regression.

Keep this file focused on continuous verification, fallback operations,
machine-readable evidence, drills, and release preparedness.

## Decision

`workflows.mbt` is a **compatibility safety net for Cloudflare Workflows**, not
a replacement platform.

The invariant this issue protects is:

> A representative Cloudflare Workflow must remain runnable on the independent
> fallback runtime without editing the workflow source.

For disaster recovery, the default contract is intentionally narrower than
"transparent migration":

- new invocations may be redirected to `workflows.mbt`
- in-flight Cloudflare instances remain a separate reconciliation problem
- state portability is not claimed unless an explicit migration mechanism is
  implemented and tested

The issue is complete only when this invariant is continuously verified and the
fallback can be exercised from a prepared artifact, not merely when more API
surface has been implemented.

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

The machine-readable evidence vocabulary should be stable and explicit:

| Evidence state | Meaning |
| --- | --- |
| `implemented` | runtime/API implementation exists |
| `repository_tested` | repository regression/E2E coverage exists |
| `pinned_differential` | same probe verified against pinned Wrangler/workerd |
| `latest_differential` | same probe verified against latest upstream packages |
| `hosted_differential` | same probe verified against hosted Cloudflare |
| `intentionally_unsupported` | difference is documented and accepted |

A capability may have several positive evidence flags at once. Do not encode
these as a single ordered status that loses provenance.

## Implementation guardrails

- Keep probe workflow source unchanged between Cloudflare and `workflows.mbt`.
- Normalize only nondeterministic or runtime-specific fields. Every ignored field
  must have a documented reason; do not normalize away semantic mismatches.
- A package version bump alone is not a compatibility failure. Contract or
  observable-behavior drift is.
- Keep pinned verification required in normal CI. Keep latest-upstream checks
  isolated so unrelated PRs do not fail only because upstream released.
- Do not silently broaden scope into D1/KV/R2/Queues/AI/Durable Objects or a full
  Workers emulator.
- Do not claim in-flight state migration, exactly-once external side effects, or
  hosted-service parity without a specific tested mechanism.
- Prefer small independently mergeable compatibility increments over one large
  rewrite of the existing oracle.

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

For each important compatibility row:

- assign a stable capability/probe identifier
- record repository-test evidence separately from upstream-differential evidence
- make pinned/latest/hosted provenance visible independently
- retain normalized expected and actual traces on failure
- make the probe runnable in isolation for debugging
- ensure the same workflow source is used on both sides of the differential

At minimum, `npm run compat:pinned` must exercise the required pinned catalog.
`npm run compat:latest` must reuse the same catalog unless a probe is explicitly
marked unavailable for the latest oracle with a documented reason.

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

### Acceptance

The contract snapshot must detect at least:

- added/removed members
- changed required/optional status
- changed parameter and return types
- changed discriminant values
- changed nested payload fields
- changed overload/callback shapes that affect supported source

Snapshot output must be deterministic and reviewable in git. A contract change
must identify the exact tracked symbol/path that drifted rather than reporting
only a package-level mismatch.

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

### Acceptance

A compatibility report must be able to show "contract clean, semantic probe
failed" and "contract changed, semantic probes still pass" as distinct outcomes.
Neither case may be collapsed into a generic compatibility boolean.

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

### Acceptance

- credentials are required only for the hosted job, never for normal PR CI
- the canary deploys into an isolated disposable test target
- cleanup is attempted on both success and failure
- the report records account-independent observable behavior only
- hosted failures are labeled separately from local Wrangler/workerd failures
- the job can be invoked manually before a compatibility-sensitive release

If hosted probing is intentionally deferred, record the decision, owner, reason,
and review trigger. "Optional" must not mean silently forgotten.

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

### Acceptance

Use a deterministic deduplication key derived from the upstream version tuple and
the compatibility-drift fingerprint. Repeated scheduled failures for the same
unresolved drift should update one record rather than create daily duplicates.

The durable record must be sufficient for an implementer to reproduce the
failure without reverse-engineering an Actions log.

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

### Acceptance

The matrix is the source of truth for evidence state. Human-facing reports may be
generated from it, but must not invent stronger claims.

Every compatibility-sensitive row needs:

- stable capability ID
- category
- implemented/repository/pinned/latest/hosted evidence flags
- last verified date
- relevant upstream version tuple
- known-difference or unsupported reason when applicable

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

### Acceptance

Produce a short operator runbook that answers, without requiring repository
archaeology:

1. how to start the prepared fallback runtime
2. how new workflow invocations are routed to it
3. what happens to Cloudflare instances already running/sleeping/retrying/waiting
4. what application-level idempotency is required
5. how events are replayed or re-delivered
6. how instance IDs avoid collisions across the transition
7. how to reconcile and eventually return traffic to Cloudflare
8. which known differences may affect the application

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

The drill fixture should exercise more than a trivial happy path. At minimum it
should include a durable step plus one suspension/recovery path such as retry,
sleep, or event wait, and it must verify local restart from persisted state.

### Acceptance

Record for every drill:

- repository commit
- fallback artifact/version
- Cloudflare oracle version/date
- exact workflow source digest
- result of Cloudflare-side execution
- result of fallback execution
- restart/replay result
- known differences encountered

A source edit between the Cloudflare run and fallback run invalidates the drill.

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

### Acceptance

The prepared artifact must be smoke-tested by the fallback drill itself. Release
metadata must identify the repository commit, MoonBit/Node dependency basis,
compatibility-oracle date, upstream version tuple, and known-differences summary.

The emergency startup path must not depend on resolving unpinned package versions
from the network.

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

## Suggested implementation sequence

Keep the existing oracle and extend it incrementally. Recommended order:

1. define stable capability IDs and the machine-readable evidence schema
2. expand nested API/type snapshot coverage
3. expand the pinned semantic differential catalog
4. make latest-upstream drift produce actionable deduplicated records
5. add hosted canary support or record the explicit defer decision
6. write the fallback operational contract
7. add the representative source-unmodified fallback drill
8. produce and smoke-test the immutable emergency artifact
9. update README/compatibility reports from the resulting evidence

Each step should leave `main` usable and should be independently reviewable.

## Suggested repository outputs

Exact filenames may follow the existing layout, but responsibilities should stay
separate. A practical shape is:

- machine-readable capability/evidence matrix under `compat/`
- semantic probe catalog under the existing differential-oracle tree
- deterministic API/type snapshots under `compat/oracle/`
- generated compatibility report under `compat-results/`
- fallback runbook under `docs/`
- representative drill fixture under `fixtures/`
- scheduled/manual latest and hosted jobs under `.github/workflows/`
- versioned release/OCI packaging definition beside the existing build tooling

Do not put generated trace artifacts into source control unless they are required
as deterministic fixtures or snapshots.

## Validation gate

Before this issue is considered complete, run and record:

~~~bash
npm run test
npm run compat:pinned
npm run compat:latest
npm run compat:report
~~~

Also run the hosted canary when configured and run the fallback drill from the
prepared emergency artifact.

When a dependency lockfile is introduced, CI and the release/drill path should
use deterministic installation rather than floating dependency resolution.

A test that was not executed must be reported as not executed, not inferred as
passing.

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
11. required validation commands pass, and the fallback drill passes from the
    prepared emergency artifact
12. generated/human compatibility reports agree with the machine-readable
    evidence matrix

## Non-goal for closure

Closure does not mean "fully Cloudflare compatible".

It means the project provides a maintained, continuously tested escape path that
makes normal dependency on Cloudflare Workflows materially safer.

## Implementation — 2026-09-28

All definition-of-done items satisfied. Pinned oracle: contract clean + all 32
differential probes pass. Latest oracle (wrangler 4.142.0 / workers-types
5.20260928.1 / workerd 1.20260928.1): contract clean + probes pass — no drift.

1. **Positioning** — README states the safety-net framing and non-goals;
   `docs/fallback-runbook.md` carries the DR contract.
2. **Evidence matrix** — `compat/capabilities.json` (38 capability rows) with
   per-flag evidence; `compat/check-capabilities.mjs` fails the run when a
   differential flag is claimed without a covering clean result, or when a
   catalog probe is unmapped.
3. **Semantic catalog** — `compat/probes/catalog.json` covers lifecycle
   (pause/resume, terminate+rollback, restart-from, delete), binding
   (create/get/batch, duplicate-id shape, missing-id code 10400), step
   (do/retry/sleep/sleepUntil/waitForEvent/timeout/NonRetryable/identity/
   context/dynamic-delay), subscriptions (filter/cursor/sensitive redaction),
   serialization (structured/collections/binary/error/cyclic; BigInt and
   unserializable-output are `differential:false` — upstream aborts the
   isolate uncatchably, local is a strict superset), Promise concurrency
   (all/allSettled/race/any/concurrent-retry/wrapped-race/mixed-event), and
   Worker fetch. Schedule surface is repository_tested (no local hosted cron
   oracle to diff against).
4. **Type drift** — `compat/oracle/api-surface.json` regenerated via
   `check.mjs --write`: 25 hashed declarations (incl. WorkflowStepContext,
   WorkflowStepConfig, rollback context/options, delay types, NonRetryableError),
   6 literal-union hashes, and per-variant field sets + hashes for all 29
   `WorkflowInstanceEvent` types.
5. **Durable drift records** — `compat/drift-record.mjs` writes
   `compat-results/drift-<key>.md` keyed on upstream-version+drift fingerprint
   and upserts one `compat-drift` GitHub issue per key when run with
   `--publish` (wired into `compatibility-latest`).
6. **Hosted canary** — implemented in `compat/canary.mjs` (disposable deploy,
   bounded catalog, hosted-vs-local normalized diff, cleanup on both paths);
   deferred pending credentials per `docs/hosted-canary.md`; the
   `compatibility-hosted` workflow stays inert until `CF_API_TOKEN`/
   `CF_ACCOUNT_ID` secrets exist.
7. **Fallback drill** — `node compat/run-drill.mjs`: `fixtures/drill` runs
   unmodified under `wrangler dev` and `workflows.mbt`, the local runtime is
   SIGKILLed mid-`step.sleep`, restarts from persisted SQLite state, and must
   produce identical output. Records land in `compat-results/drill-*.json`.
8. **Emergency artifact** — `package-lock.json` committed; CI uses `npm ci`;
   MoonBit pinned via `.moonbit-toolchain.json` (moon 0.1.20260920, moonc
   0.10.14+7d59c7ec9): monitoring workflows install `latest` + assert equality
   with the pin (upstream releases surface as explicit drift), while the
   release workflow installs the exact sha256-verified tarballs vendored as
   assets on the repo's own immutable `toolchain/0.1.20260920` release via
   `scripts/install-toolchain.mjs` — independent of upstream channel movement;
   tag `v*` builds
   `.github/workflows/release.yml`, which packages the runtime tarball,
   extracts it to a clean directory, runs the drill from the extracted tree,
   and publishes a GitHub Release whose `metadata.json` records commit,
   toolchain, oracle date, upstream tuple, drill result, and the
   known-differences summary.
9. **DR contract** — runbook §"Supported disaster-recovery model": new
   invocations switch; in-flight Cloudflare instances are reconciled
   separately — no state-portability claim.
10. **Claims scoping** — version/date tuples in `manifest.json`, report, and
    release metadata; known differences in COMPATIBILITY.md + matrix
    `intentionally_unsupported` rows.
11. **Validation gate** (all executed 2026-09-28): `npm test` 40/40 e2e + host
    suite pass; `npm run compat:pinned` pass; `npm run compat:latest` pass;
    `npm run compat:report` generated; drill passed from repo checkout and
    from the extracted release artifact (`--skip-cloudflare` in the artifact
    path — the oracle side is covered by compat:pinned). Hosted canary not
    executed — credentials not provisioned (deferred, see docs).
12. **Report ↔ matrix** — `compat:report` re-validates the matrix and renders
    its rows; contract and semantic outcomes are reported as distinct axes per
    oracle.

Engine-level parity fixes driven by the expanded catalog: terminal
NonRetryableError event shape (`WorkflowFatalError` + replayable plain-Error),
`waitForEvent` timeout error surface (`Execution timed out after <ms>ms`),
`ctx.config` drops function-valued leaves, step results are
serialize-then-deserialize round-trips (Error own-props dropped, `name`
non-enumerable), cyclic step output is a fast catchable `TypeError` with
`attempt_completed` and no `step_errored`, duplicate `create()` surfaces a
plain-named `Error`, `deleteBatch` missing id reports code 10400, and
`durationMs` is normalized with ±100ms tolerance (wall-clock emit-time jitter,
documented in `compat/normalize.mjs`).
