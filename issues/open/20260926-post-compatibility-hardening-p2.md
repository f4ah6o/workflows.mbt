# Post-compatibility hardening after broad Cloudflare Workflows parity

Status: open  
Created: 2026-09-26  
Target: after broad-compatibility milestone



## Triage — 2026-09-27

This file is the optional/long-horizon hardening backlog. Concrete correctness
regressions discovered in already-claimed compatibility surfaces are tracked
separately in `20260927-current-code-review-findings.md` so they are not buried
among platform-breadth work.

In particular:

- scheduled `default_retention` propagation and REST event-body fidelity are
  focused correctness follow-ups, not generic P2 hardening
- inbound Worker request-body streaming is tracked in the focused review issue
  because it is a concrete default-Worker HTTP gap
- this file keeps REST completeness scoped to optional transports,
  pagination/filter fidelity, and documented stable error-code fidelity

This separation should make it clear which work fixes current behavior versus
which work expands the supported platform.

## Context

The broad compatibility milestone implements and tests the source/runtime surface
needed for representative existing Cloudflare Workflows applications:

- source-unmodified `cloudflare:workers`
- concurrent durable Promise operations
- practical structured-value persistence
- durable rollback / compensation
- schedules
- `WorkflowInstance.subscribe()`
- workflow-scoped instance IDs and retention
- default Worker HTTP handler
- core REST facade

This follow-up tracks work that improves operational fidelity or platform breadth
but is not required to close
`20260926-cloudflare-workflows-full-compatibility.md`.

## P2 — persisted ReadableStream output

Cloudflare JavaScript Workflows support fresh unlocked
`ReadableStream<Uint8Array>` step results.

Design a bounded persisted streaming contract that:

- does not buffer an unbounded stream into RAM
- supports crash/restart while writing or replaying a stream
- makes commit visibility atomic
- has explicit size/accounting behavior
- can map to SQLite first and object/blob storage later

Until then, stream step output must continue to fail explicitly.

## P2 — complete RpcSerializable audit

Compare the current Workers RPC serializable surface against the local structured
codec.

Already covered:

- Date
- BigInt
- RegExp
- ArrayBuffer / DataView / typed arrays
- Map / Set
- Error
- nested structured values

Add fixtures only for upstream-supported types whose semantics are relevant to
Workflows persistence. Keep unsupported values explicit.

## P2 — timeout durability audit

Current per-attempt timeout enforcement uses a host timer.

Audit and, where necessary, move timeout decisions into durable state for:

- crash around an in-flight timeout deadline
- callback still running when timeout fires
- timeout vs retry ordering
- dynamic retry delay after timeout
- long timeout persistence
- timer granularity

The external-side-effect delivery model remains at least once.

## P2 — multi-process executor lease

Before claiming that multiple runtime processes can safely share one database,
add an instance lease/claim model with:

- one active executor per instance/epoch
- stale lease recovery
- crash-safe expiry/release
- no duplicate callback execution caused solely by scheduler races
- rollback and scheduled instances using the same claim mechanism

Do not describe SQLite as multi-process executor-safe before this exists.

## P2 — storage abstraction hardening / PostgreSQL proof

Keep storage methods workflow-semantic rather than SQL-shaped.

Review atomic boundaries for:

- step completion
- retry scheduling
- event consume + wait completion
- restart-from-step invalidation
- rollback registration/execution
- concurrent branch completion
- scheduled firing claims
- subscription event append

After the interface is stable, add PostgreSQL as a proof that the runtime is not
SQLite-specific.

## P2 — REST completeness

The current facade covers core instance operations and batch create.

Remaining optional Cloudflare REST transports:

- step-output endpoint
- streaming `GET .../subscribe`
- pagination/filter details beyond the current local result envelope
- exact stable API error codes where documented

REST behavior must stay a thin adapter over the same runtime used by Workers
bindings and CLI.

## P2 — Wrangler environment overlays

Add named Wrangler environment support only where it affects Workflows:

- `--env`
- environment-specific vars
- environment-specific Workflow binding overrides where supported
- local secret-file behavior under named environments

Do not turn the project into a full Wrangler clone.

## P2 — Cloudflare service-binding adapters

Optional adapters for real projects that use `this.env` beyond Workflow
bindings:

- D1 -> SQLite/PostgreSQL
- KV -> generic KV
- R2 -> S3-compatible/object-storage adapter
- Queues -> pluggable queue
- Service Bindings -> local/HTTP

Workers AI and Durable Objects remain separate unless a concrete Workflows
fixture requires them.

## P2 — error compatibility audit

Maintain a table of stable documented names/codes/shapes for:

- duplicate instance ID
- unknown instance
- invalid restart target
- serialization failure
- invalid event type
- timeout
- retry exhaustion
- `NonRetryableError`
- invalid lifecycle transitions
- rollback failure
- REST errors

Prefer clear local errors over invented Cloudflare codes when upstream behavior
is undocumented.

## P2 — account-plan retention policy adapter

Cloudflare uses account-plan defaults when neither per-instance retention nor
Workflow `default_retention` is supplied.

The local runtime currently treats unspecified retention as unlimited because it
has no account-plan context.

If plan emulation becomes useful, make it an explicit local policy/configuration
adapter rather than silently choosing a Cloudflare plan.

## Acceptance

This follow-up may be closed incrementally. Each checked compatibility behavior
must have a fixture or test; operational claims such as multi-process safety must
not be made before the corresponding failure/recovery tests exist.
