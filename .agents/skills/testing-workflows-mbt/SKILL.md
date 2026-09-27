---
name: testing-workflows-mbt
description: How to run and exercise the workflows.mbt dev server (CLI + REST facade + cron scheduler) for end-to-end testing
---

# Testing the workflows.mbt dev server

The repo is a MoonBit+Node durable-workflow runtime emulating Cloudflare Workflows. There is no browser UI — the user-facing surface is the `host/cli.mjs` CLI plus an HTTP REST facade + default-Worker fetch host.

## Dev Secrets Needed
- none

## Start the dev server
```
node host/cli.mjs dev --config <wrangler.jsonc> --storage <db-path> --build-dir <dir> --port <p> --poll-ms 50
```
- `--port` default 8787, `--host` default 127.0.0.1, `--no-http` disables HTTP.
- The server prints nothing on startup — poll `curl http://127.0.0.1:<port>/` until it responds.
- Always pass explicit `--storage`/`--build-dir` paths (default is `.workflows/` next to the wrangler config) so test state is isolated and inspectable. `wrangler.main` may be an absolute path, so a throwaway config in /tmp can reuse fixture sources.
- Deps: `npm install` (esbuild, better-sqlite3, jsonc-parser); `dist/workflows_core.mjs` must exist (npm run build:core).

## REST routes (host/rest.mjs)
Base: `/accounts/local/workflows/<name>/instances`
- `POST /instances` `{instance_id, params}` — params may be a JSON string or object.
- `GET /instances`, `GET /instances/<id>` — Cloudflare-style envelope `{success,errors,result}`; `result.output` holds the workflow return value.
- `POST /instances/<id>/events/<type>` — body is the event payload verbatim.
- `PATCH /instances/<id>/status` `{status: pause|resume|terminate|restart, from:{name,count,type}}`.
- Non-matching paths fall through to the default-Worker `fetch` handler (fixtures/cloudflare-basic has `/stream`, `/cookies`, `/first-chunk` routes).

## CLI one-shot commands share the sqlite storage
`cli.mjs trigger|status|event|pause|resume|restart|terminate <wf> <id> --config <c> --storage <db>`.
listRunnable has no cross-process claim, so running CLI commands against the same DB as a live dev server can double-execute; use a standalone storage path for CLI-only tests.

## Inspecting internals (no REST route for steps/events/timers)
Query the sqlite DB read-only with better-sqlite3 from repo node_modules. From a script outside the repo:
```js
import { createRequire } from "node:module";
const require = createRequire("/path/to/repo/package.json");
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true });
```
Tables: `instances` (status, output, success_retention_ms, error_retention_ms, expires_at, scheduled_time, public_id), `steps` (name, type, ordinal, state), `timers`, `scheduled_runs`, `attempts`, `rollback_registrations`.

## Timing behaviors to exploit
- Scheduler claims instances for current AND previous minute on first tick; then each minute boundary (`enqueueSchedules` runs every pollMs inside `dev()`).
- Retention expiry runs at the top of each `runPending` — terminal rows with N ms retention vanish within ~N+pollMs. Poll the DB at ~10ms to catch transient rows; REST polling is too slow to reliably see them.
- `scheduled_runs.instance_id` has `ON DELETE CASCADE` — claim rows disappear when the instance row expires.
- Invalid cron expressions throw `TypeError: Invalid cron field value` inside the dev loop and crash the process (exit 1). Cloudflare weekday numbering is 1=SUN..7=SAT; numeric 0 is rejected. To test weekday semantics, run a config on the actual current weekday — check `date -u` first.
- `waitForEvent` fixtures often use short timeouts (e.g. "5 seconds") — send events promptly after the instance reaches `waiting`.
- Inbound streaming check: `node:http` request with chunked body — worker must respond before `request.end()`; a buffering host can never do that.
