# workflows.mbt

**Run Cloudflare Workflows-compatible TypeScript/JavaScript without requiring Cloudflare Workflows.**

`workflows.mbt` is a MoonBit-first durable workflow runtime. Existing workflow
source keeps importing `cloudflare:workers`; the local compatibility host
redirects that module at build time and delegates durable execution decisions to
the MoonBit kernel.

The migration target is intentionally small:

```text
Before: npx wrangler dev
After:  workflows dev --config wrangler.jsonc
```

The workflow source itself should not need a migration rewrite.

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

`pause`, `resume`, `restart`, and `terminate` commands are also available.

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
npm run test:e2e
```

The E2E suite includes real child runtime processes that are killed with
`SIGKILL`, then restarted against the same SQLite database. Coverage includes
sequential and parallel replay, retry/sleep/event durability, structured
non-JSON values, wrapped race winner persistence, rollback recovery, scheduled
instances, subscriptions, Worker HTTP bindings, retention, and the REST facade.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the exact implemented surface.

## Scope

The current runtime is deliberately single-machine. It does not require Redis,
Kafka, Kubernetes, distributed consensus, or a multi-node scheduler. Do not point
multiple executor processes at the same SQLite database until the planned
instance lease/claim boundary is implemented.

Cloudflare service bindings such as D1, KV, R2, Queues, Workers AI, Durable
Objects, and Service Bindings are not emulated. User-provided values/adapters can
be injected into `this.env`; service-specific adapters are future work.


## Compatibility status

The tested surface is intended as a **broad Cloudflare Workflows-compatible local
runtime**, not a full Workers platform clone.

Notable current differences include persisted `ReadableStream<Uint8Array>`
outputs, the complete Workers RpcSerializable universe, Cloudflare account-plan
default retention, multi-process executor leases, Cloudflare service-binding
emulators, and the REST subscription streaming transport.

See [COMPATIBILITY.md](./COMPATIBILITY.md) and
[compat/cloudflare/VERSION.md](./compat/cloudflare/VERSION.md) for the tested
surface and oracle.
