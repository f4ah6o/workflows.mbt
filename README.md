# workflows.mbt

**Run Cloudflare Workflows-compatible TypeScript/JavaScript without requiring Cloudflare Workflows.**

`workflows.mbt` is a MoonBit-first durable workflow runtime. Existing workflow
source keeps importing `cloudflare:workers`; the local compatibility host
redirects that module at build time and delegates durable execution decisions to
the MoonBit kernel.

**Positioning: a compatibility safety net for Cloudflare Workflows.** Use
Cloudflare normally; keep workflow source portable and continuously verified
against this independent fallback runtime. Explicit non-goals: competing with
Cloudflare Workflows, cloning the whole Workers platform, reproducing
Cloudflare's global/distributed infrastructure, bundling D1/KV/R2/Queues/AI/
Durable Objects emulators into core, or claiming transparent migration of
in-flight Cloudflare state. See `docs/fallback-runbook.md` for the supported
disaster-recovery model.

The migration target is intentionally small:

```text
Before: npx wrangler dev
After:  workflows dev --config wrangler.jsonc
```

The workflow source itself should not need a migration rewrite.

## Install

The runtime ships as an npm-package tarball with a **prebuilt kernel** — a
consumer machine needs only Node.js >= 22; no MoonBit toolchain and no
repository checkout are required.

From a release artifact (`v*` GitHub Releases publish
`f4ah6o-workflows-mbt-<version>.tgz`):

```bash
tar -xzf f4ah6o-workflows-mbt-<version>.tgz
cd package
npm ci --omit=dev        # deterministic — resolved from the packaged npm-shrinkwrap.json
node host/cli.mjs doctor --config /path/to/project/wrangler.jsonc
node host/cli.mjs dev    --config /path/to/project/wrangler.jsonc
```

Or install the tarball into an existing project, which also puts the
`workflows` bin on `npx`/PATH:

```bash
npm install ./f4ah6o-workflows-mbt-<version>.tgz   # or a release download URL
npx workflows doctor --config wrangler.jsonc
npx workflows dev --config wrangler.jsonc
```

The same tarball is produced locally with `npm pack` (runs `build:core` if
needed). From a repository checkout, develop with:

```bash
npm install
npm run build:core       # requires the pinned MoonBit toolchain
```

`scripts/install-toolchain.mjs` installs the pinned MoonBit toolchain from
this repository's vendored release assets.

## Architecture

```text
existing Cloudflare Workflow source (TS/JS, unchanged)
        |
        v
compatibility host
  - esbuild resolver for cloudflare:workers / cloudflare:workflows
  - TypeScript transpilation
  - Web API / user callback invocation
        |
        v
MoonBit durable-execution kernel
  - deterministic step identity
  - replay decisions
  - retry/backoff/default decisions
  - timer deadline decisions
  - restart boundary decisions
        |
        v
host storage/scheduler bridge
  - SQLite adapter (WAL)
  - atomic state transitions
  - concurrent durable branches
  - rollback / compensation state
  - durable timers / event queue
  - cron scheduler / subscriptions
  - single-machine scheduler
```

The generated MoonBit JS foreign library is loaded by the host. JavaScript is
the compatibility and OS bridge; it is not a second user-facing workflow DSL.
SQLite SQL is isolated in `host/storage/sqlite.mjs`.

MoonBit's JS target is used because it provides a narrow, stable boundary to the
JavaScript callback host. Moving SQLite I/O behind a native MoonBit/C adapter is
possible later without changing the workflow API.

## Current durable model

The runtime does **not** persist a JavaScript VM stack or continuation. On resume
it invokes `run(event, step)` from the beginning.

Completed steps return their persisted output without invoking the callback.
Sleeping, retrying, and event-waiting steps persist deadlines/state in SQLite and
suspend the workflow process-free. Concurrent durable branches can commit
independently; replay reuses the committed branch outputs. Rollback registrations,
retry deadlines, scheduled firings, and subscription history are durable as well.

When the scheduler resumes an instance, the workflow replays from the beginning
and durable identities select previously committed outputs rather than rerunning
their callbacks.

Step identity is:

```text
(instance_id, step_type, step_name, step_count)
```

`step_count` is 1-origin and scoped to same name + same type, matching the
current Cloudflare restart/step-context model.

### Delivery semantics

`step.do` provides durable result/replay semantics with **at-least-once callback
execution**, not exactly-once external side effects.

A crash can occur after an external side effect succeeds but before the step
result is committed. In that case the callback may run again. Design external
effects to be idempotent or use application-level idempotency keys.

## Configuration

Existing `wrangler.jsonc` remains the primary project config:

```jsonc
{
  "name": "example",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-26",
  "workflows": [
    {
      "name": "my-workflow",
      "binding": "MY_WORKFLOW",
      "class_name": "MyWorkflow"
    }
  ]
}
```

The local host consumes the workflow `name`, `binding`, `class_name`,
`schedules`, and `default_retention`, plus top-level `vars`,
`compatibility_flags`, and local `.dev.vars` / `.env` values. Unknown
Wrangler fields remain ignored unless an adapter supports them.

Optional local-only settings belong in `workflows.mbt.json`:

```json
{
  "storage": {
    "type": "sqlite",
    "path": ".workflows/workflows.db"
  }
}
```

## CLI

Build the MoonBit kernel and install host dependencies:

```bash
npm install
npm run build:core
```

Run a project:

```bash
node host/cli.mjs dev --config fixtures/cloudflare-basic/wrangler.jsonc
```

(installed consumers use `workflows dev --config wrangler.jsonc` — the `bin`
entry points at `host/cli.mjs`)

Preflight a project before routing traffic to it:

```bash
node host/cli.mjs doctor --config wrangler.jsonc
```

`doctor` checks that the config parses, required secrets resolve, storage
opens, the prebuilt kernel loads, the source bundles unmodified, the
configured Workflow classes export, and declared binding adapters construct —
exit code is non-zero on failure, `--json` prints a machine-readable report.

Trigger and inspect instances:

```bash
node host/cli.mjs trigger my-workflow \
  --config fixtures/cloudflare-basic/wrangler.jsonc \
  --params '{"name":"Alice","url":"https://example.com/data"}'

node host/cli.mjs status my-workflow <instance-id> --config wrangler.jsonc

node host/cli.mjs event my-workflow <instance-id> approved \
  --config wrangler.jsonc \
  --payload '{"approved":true}'
```

`pause`, `resume`, `restart`, and `terminate` commands are also available;
`workflows --help` prints the full surface and `workflows --version` prints
the package version.

By default `workflows dev` also listens on `127.0.0.1:8787`. It dispatches
ordinary requests to an unchanged default Worker `fetch` export and exposes the
local Workflows REST compatibility facade. Use `--no-http` for scheduler-only
operation.

## Source compatibility fixture

`fixtures/cloudflare-basic/src/index.ts` imports:

```ts
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
```

The source is bundled unchanged. An esbuild resolver maps
`cloudflare:workers` to the local compatibility module; source files are never
patched.

Current Cloudflare documentation also imports `NonRetryableError` from
`cloudflare:workflows`, so that module specifier is redirected as well.

## Tests

```bash
npm run check:moon
npm run build:core
npm run test:moon
npm run test:host
npm run test:compat
npm run test:e2e
npm run test:consumer
```

`test:consumer` is the clean-machine journey: `npm pack`, extract to a temp
dir, `npm ci --omit=dev`, `doctor`, `dev`, an instance killed with `SIGKILL`
mid-sleep and completed after restart, then an `npm install <tarball>` bin
check — all with a PATH that excludes the MoonBit toolchain.

The E2E suite includes real child runtime processes that are killed with
`SIGKILL`, then restarted against the same SQLite database. Coverage includes
sequential and parallel replay, retry/sleep/event durability, structured
non-JSON values, wrapped race winner persistence, rollback recovery, scheduled
instances, subscriptions, Worker HTTP bindings, retention, and the REST facade.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the exact implemented surface.

## Continuous Cloudflare compatibility oracle

Compatibility is verified against Cloudflare upstream rather than only
repository-owned expectations.

```bash
npm run compat:pinned
npm run compat:latest
npm run compat:report
```

`compat:pinned` is credential-free and runs in normal PR/push CI. It validates
the pinned Wrangler / Workers types / workerd contract, then executes the same
TypeScript probe source under both Cloudflare `wrangler dev` and `workflows.mbt`.
The resulting observable traces are normalized before comparison.

`compat:latest` is intentionally separated into the scheduled/manual
`compatibility-latest` workflow. It resolves current upstream packages
**once** into a shared candidate manifest — exact versions, registry
integrity hashes, the real transitive miniflare/workerd the run executed —
and every phase (candidate-scoped typecheck, contract, differential,
docs-watch, verdict, response, update-candidate) consumes that one candidate
under a single run id. The run ends in a machine-readable verdict
(`compatible` / `contract-drift` / `semantic-drift` /
`upstream-acquisition-failure` / `upstream-execution-failure` /
`local-runtime-failure` / `incomplete-evidence` / `hosted-not-performed`), so
an upstream outage, a missing result file, or a stale record can never be
reported as compatibility. A new upstream release therefore does not block
unrelated pull requests just because a version number changed.

The pinned versions live in `compat/oracle/manifest.json`. Machine-readable
results and `compat-results/report.md` are uploaded as GitHub Actions artifacts.
The evidence matrix is `compat/capabilities.json` (validated by
`compat/check-capabilities.mjs`, rendered into the report). Latest-oracle
drift produces deduplicated response packets via `compat/drift-record.mjs`
— one record per problem identity (a new upstream version recurs the same
record, it never spawns a duplicate), written into `issues/open/` following
the repository's md-issue convention; publishing to GitHub Issues happens
only behind `--publish` and records its real outcome. A `compatible` verdict
emits `compat-results/proposed-manifest.json` — a verified update candidate
whose application is manual (see
[docs/upstream-tracking.md](./docs/upstream-tracking.md) for the full
operating procedure).

`node compat/run-drill.mjs` runs the source-unmodified fallback drill — the
fixture under `fixtures/drill/` executes under `wrangler dev` and
`workflows.mbt`, the local runtime is SIGKILLed mid-suspension, and the
instance must complete from persisted state with identical output. A hosted
Cloudflare canary is implemented but credential-gated and deferred; see
`docs/hosted-canary.md`.

`npm run test:scenario` runs the practical consumer scenario
(`scripts/consumer-scenario.mjs` against `examples/scenario/`): an ordinary
Cloudflare Workflow performs an external HTTP side effect behind a retry
policy, the runtime is SIGKILLed after the downstream effect was applied but
before the step result committed (at-least-once delivery; the business
idempotency key dedups the replay — exactly-once external effects are not
claimed), SIGKILLed again while parked on `waitForEvent`, then restarted and
completed. Evidence lands in `compat-results/scenario-consumer.json`.

## Scope

The current runtime is deliberately single-machine. It does not require Redis,
Kafka, Kubernetes, distributed consensus, or a multi-node scheduler. Executor
processes on one machine may share a SQLite database — instances are claimed by
a lease (`lease_owner`/`lease_expires_at`) with heartbeat renewal and
commit-time fencing, so a crashed executor's work is reclaimed without
duplicating committed steps.

KV, D1, R2, Queue producers, and Service Bindings have local adapters (configure
`adapters` in `workflows.mbt.json`; see `host/adapters.mjs`). Workers AI and
Durable Objects are not emulated.


## Compatibility status

The tested surface is intended as a **broad Cloudflare Workflows-compatible local
runtime**, not a full Workers platform clone. The intentional differences are
maintained in one place — see [COMPATIBILITY.md](./COMPATIBILITY.md) "Known
differences" and the machine-readable matrix in
[compat/capabilities.json](./compat/capabilities.json) — and
[compat/cloudflare/VERSION.md](./compat/cloudflare/VERSION.md) for the oracle
basis.
