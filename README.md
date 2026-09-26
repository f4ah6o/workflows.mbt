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
  - retry/backoff decisions
  - timer deadline decisions
  - restart boundary decisions
        |
        v
host storage/scheduler bridge
  - SQLite adapter (WAL)
  - atomic state transitions
  - durable timers / event queue
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
suspend the workflow process-free. When the scheduler resumes an instance, the
workflow replays to the first unfinished operation.

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

For v0.1 the runtime consumes `main` and the workflow `name`, `binding`, and
`class_name`. Other Wrangler fields are preserved and ignored unless an adapter
supports them.

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

The E2E suite includes a real child runtime process that is killed with
`SIGKILL`, then restarted against the same SQLite database. It verifies durable
step replay and that sleep deadlines do not restart from zero.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the exact implemented surface.

## Scope

v0.1 is deliberately single-machine. It does not require Redis, Kafka,
Kubernetes, distributed consensus, or a multi-node scheduler.

Cloudflare service bindings such as D1, KV, R2, Queues, Workers AI, Durable
Objects, and Service Bindings are not emulated. User-provided values/adapters can
be injected into `this.env`; service-specific adapters are future work.
