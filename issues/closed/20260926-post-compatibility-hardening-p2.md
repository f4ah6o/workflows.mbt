# Post-compatibility hardening after broad Cloudflare Workflows parity

Status: closed  
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

Status: done (2026-09-28) — `step_streams`/`stream_chunks` chunked persistence,
atomic commit with the step row, `limits.streamBytes` cap, `WorkflowStreamError`
on uncommitted streams, restart/replay + REST octet-stream coverage in e2e.

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

Status: done (2026-09-28) — `Headers`/`Request`/`Response`/`Blob` added;
reconciled with the upstream differential oracle: cyclic graphs fail the
serialize boundary with a catchable `TypeError` (step ends `failed`, not
retried) and error own-properties are dropped on decode with `name`
non-enumerable. Remaining unsupported values (functions, symbols, custom
prototypes, `WritableStream`) still fail explicitly. The complete upstream
surface is not claimed (COMPATIBILITY.md Known differences).

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

Status: done (2026-09-28) — `attempt-timeout` timers are written before the
attempt runs; restart classifies expired in-flight attempts as
`WorkflowStepTimeoutError` and stale `running` attempts as
`WorkflowAttemptInterruptedError`; long timeouts re-arm against a wall-clock
deadline. Covered by e2e restart tests.

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

Status: done (2026-09-28) — `lease_owner`/`lease_expires_at` claim on
`runInstance`, heartbeat at `leaseMs/3` that stops once a renewal fails,
`releaseLease` in `finally`, `listRunnable` excludes live foreign leases
(expired leases reclaimable), and durable boundaries re-check the lease and
abort `lease-lost`. Commit-time fencing: every run-scoped commit (step
completion, retry/timeout scheduling, rollback boundaries, timers, status
writes, stream chunks) re-validates `lease_owner`/`lease_expires_at` inside
its own transaction and throws `WorkflowLeaseLostError`, so a stalled
executor cannot commit after another executor claims the instance.
Lifecycle commands pass no lease and stay unfenced. Covered by e2e
two-executor and fencing tests.

Before claiming that multiple runtime processes can safely share one database,
add an instance lease/claim model with:

- one active executor per instance/epoch
- stale lease recovery
- crash-safe expiry/release
- no duplicate callback execution caused solely by scheduler races
- rollback and scheduled instances using the same claim mechanism

Do not describe SQLite as multi-process executor-safe before this exists.

## P2 — storage abstraction hardening / PostgreSQL proof

Status: done (2026-09-29) — `host/storage/postgres.mjs` implements the full
`host/storage/storage.mjs` contract over `pg` (optional dependency; a
worker-thread bridge keeps the synchronous contract unchanged), with the
same atomic boundaries as SQLite: step completion, retry scheduling, event
consume + wait completion, restart-from-step invalidation, rollback
registration/execution, concurrent branch completion, scheduled firing
claims (`INSERT ... ON CONFLICT` + loser rollback), subscription event
append, and leases (`SELECT ... FOR UPDATE` fencing in `assertLease`,
conditional `UPDATE` claim/renew/release). Backend selection:
`workflows.mbt.json` `storage.type`/`url`/`schema`, or `--storage
postgres://...` on the CLI; documented in README + runbook.
`tests/storage.test.mjs` runs the shared contract + runtime suite against
Postgres when `WORKFLOWS_POSTGRES_URL` is set (clean skip otherwise, CI
runs it against a postgres service container); a two-connection race test
covers cross-connection claim atomicity.

The `pg` client lives in `postgres-worker.mjs`: the Storage contract is
synchronous (matching better-sqlite3), so each call is a request/response
exchange — postMessage, `Atomics.wait` on a SharedArrayBuffer flag,
`receiveMessageOnPort` for the reply — giving BEGIN..COMMIT the same
single-writer atomicity SQLite gets from `db.transaction()`.

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

Status: done (2026-09-28) — `GET .../step` output endpoint (JSON /
octet-stream / `[REDACTED]`), `GET .../subscribe` SSE with `id:` cursors and
`?cursor=`/`?filter=`, list `?status=` + `?page=`/`?per_page=` with
`result_info.total_count`, and a documented error-code table in
COMPATIBILITY.md. Covered by e2e.

The current facade covers core instance operations and batch create.

Remaining optional Cloudflare REST transports:

- step-output endpoint
- streaming `GET .../subscribe`
- pagination/filter details beyond the current local result envelope
- exact stable API error codes where documented

REST behavior must stay a thin adapter over the same runtime used by Workers
bindings and CLI.

## P2 — Wrangler environment overlays

Status: done (2026-09-28) — `--env <name>` selects `env.<name>` with
Wrangler's documented inheritance: non-inheritable keys (`vars`, `secrets`,
`workflows`, `kv_namespaces`, `d1_databases`, `r2_buckets`, `queues`,
`services`) must be declared per environment with no top-level fallback;
inheritable keys fall back; unknown names fail. Secret files match
Wrangler: `.dev.vars.<env>` replaces `.dev.vars` wholesale, an applicable
`.dev.vars` excludes all `.env` files, and `.env` files merge as
`.env.<env>.local` > `.env.local` > `.env.<env>` > `.env`.

Add named Wrangler environment support only where it affects Workflows:

- `--env`
- environment-specific vars
- environment-specific Workflow binding overrides where supported
- local secret-file behavior under named environments

Do not turn the project into a full Wrangler clone.

## P2 — Cloudflare service-binding adapters

Status: done (2026-09-28) — `adapters` in `workflows.mbt.json`: KV, D1, R2
persist under the adapters directory; queue producers `loopback`/`spool`;
service bindings forward `fetch` to a URL. Workers AI / Durable Objects
remain out of scope.

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

Status: done (2026-09-28) — Error surface table in COMPATIBILITY.md.

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

Status: done (2026-09-28) — `retention.plan` (`"free"` 3d/3d, `"paid"`
7d/7d) in `workflows.mbt.json`; no silent plan choice.

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

## Progress — 2026-09-28

Partially advanced by the dependency-insurance implementation (see
`issues/closed/20260926-cloudflare-dependency-insurance.md`):

- **Error compatibility audit** — several stable error surfaces are now
  upstream-differential-verified rather than undocumented: terminal
  `NonRetryableError` emits `WorkflowFatalError` on the event stream and a
  plain-named `Error` to `run()`; `waitForEvent` timeout rejects with
  `Execution timed out after <ms>ms`; duplicate `create()` rejects with a
  plain-named `Error`; `deleteBatch` on a missing id reports `code: 10400`;
  cyclic step output rejects fast with a catchable `TypeError`. Still open:
  a consolidated table for every row above plus REST error codes.
- **Serialization audit** — `ser-*` probes now diff Error round-trips
  (own-properties dropped upstream), cyclic values, and structured/binary/
  collection types against upstream. `ser-bigint` and `ser-unsupported` are
  catalogued `differential:false`: upstream aborts the isolate uncatchably,
  so the intentional difference is documented in the matrix rather than
  hidden.
- **Fallback drill** — `compat/run-drill.mjs` exercises durable step +
  suspension + SIGKILL restart from persisted state.

Nothing remains open. Persisted ReadableStream output, RpcSerializable
universe, timeout durability audit, multi-process executor lease, PostgreSQL
storage proof, REST optional transports, Wrangler env overlays,
service-binding adapters, and the account-plan retention adapter all landed
— the PostgreSQL proof completed on 2026-09-29 (see the section above);
every other section closed on 2026-09-28. File moved to `issues/closed/`.
