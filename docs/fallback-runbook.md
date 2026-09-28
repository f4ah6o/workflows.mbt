# Fallback operational runbook

How to switch new workflow execution from Cloudflare Workflows to
`workflows.mbt` during an outage or unacceptable platform change.

## Supported disaster-recovery model

```text
Cloudflare unavailable / unacceptable
        |
        +--> route NEW workflow invocations to workflows.mbt
        |
        +--> reconcile already-running Cloudflare instances separately
```

The contract is intentionally narrow:

- **New invocations** can be redirected to `workflows.mbt` — workflow source is
  source-compatible and verified by the pinned differential catalog.
- **In-flight Cloudflare instance state is not portable.** There is no tested
  migration mechanism for instances that were sleeping, retrying, or waiting on
  events when Cloudflare became unavailable. Treat them as lost and re-drive
  them at the application level (see "Reconciliation" below).

Do not claim transparent migration. A clear non-guarantee beats an untested
state-migration claim.

## 1. Start the prepared fallback runtime

From a **release artifact** (recommended — the kernel is prebuilt; Node.js
>= 22 is the only requirement, no MoonBit toolchain):

```bash
tar -xzf f4ah6o-workflows-mbt-<version>.tgz
cd package
npm ci --omit=dev        # deterministic — packaged npm-shrinkwrap.json
```

or install it into the application project (`npm install <artifact.tgz>`
provides the `workflows` bin).

From a **checkout** (development — requires the pinned MoonBit toolchain):

```bash
npm ci                 # deterministic install from the committed lockfile
npm run build:core     # build the MoonBit durable kernel
```

`--config` accepts the same `wrangler.jsonc` the application already uses —
no source edit is required. Point `--storage` at a durable filesystem path.

**Preflight before routing any traffic** — config parse, required secrets,
storage writability, prebuilt kernel, unmodified source bundling, Workflow
class exports, and adapter construction:

```bash
node host/cli.mjs doctor --config wrangler.jsonc --storage ./workflows.sqlite
```

Start the runtime:

```bash
node host/cli.mjs dev --config wrangler.jsonc --port 8787 --storage ./workflows.sqlite
```

Smoke-check end to end:

```bash
node host/cli.mjs trigger <workflow-name> --params '{}' --config wrangler.jsonc --storage ./workflows.sqlite
node host/cli.mjs status <workflow-name> <instance-id> --config wrangler.jsonc --storage ./workflows.sqlite
```

## 2. Route new invocations

Replace the Cloudflare Worker request target with the `workflows.mbt` dev
server endpoint (same `fetch` surface: `POST` to the Worker's default fetch
handler, or use the binding API inside a Worker deployed on the fallback
runtime). `POST /create`-style application routes work unchanged — the binding
(`env.MY_WORKFLOW.create/get/...`) behaves the same on both runtimes.

## 3. Cloudflare instances in flight at cutover

Instances that were queued/running/sleeping/waiting/retrying on Cloudflare
**do not resume** on `workflows.mbt`. They are not visible to the fallback
runtime and their persisted Cloudflare state does not transfer.

Application owners must decide per workflow:

- wait for Cloudflare to recover and let them finish there, or
- re-drive them as new instances on the fallback (requires the steps below to
  be idempotent).

## 4. Application-level idempotency

Step callbacks may run **at least once** on each runtime, and a Cloudflare
instance re-driven on the fallback repeats its steps from the beginning.
External side effects (HTTP calls, writes, emails) in `step.do` callbacks must
be idempotent or keyed by instance id + step name.

## 5. Events

`waitForEvent` waits registered on Cloudflare do not carry over. After
re-driving an instance on the fallback, re-deliver `sendEvent` payloads the
application still expects. Event ordering and `subscribe()` cursor positions
are runtime-local.

## 6. Instance IDs

Workflow-scoped IDs must not collide between the two runtimes' views of the
same workflow. Prefer letting the fallback generate fresh IDs (`create()`
without `id`), or namespace re-driven ids (e.g. `<original-id>-fallback-1`) so
Cloudflare-side history stays distinguishable during reconciliation.

## 7. Reconciliation and return to Cloudflare

1. Enumerate instances started on the fallback during the outage (storage file
   or application records).
2. When Cloudflare is healthy, stop routing new invocations to the fallback.
3. Instances still running on the fallback may be left to complete there —
   `terminate()` them only if the application can re-drive them on Cloudflare
   idempotently.
4. There is no state push-back mechanism; do not copy SQLite state into
   Cloudflare.

## 8. Known differences that may affect the application

See `COMPATIBILITY.md` "Known differences" and `compat/capabilities.json`
(`intentionally_unsupported` rows). Currently relevant:

- BigInt step output aborts the upstream isolate uncatchably; locally it
  round-trips — code relying on the upstream crash semantics does not exist.
- The complete Workers RpcSerializable surface is not claimed; unsupported
  values (functions, symbols, custom prototypes, `WritableStream`) fail
  explicitly at the serialize boundary.
- Account-plan default retention is opt-in via `workflows.mbt.json`
  `retention.plan`; without it, unspecified retention stays unlimited.
- Multiple executor processes on one machine may share a storage file
  (instances are claimed by lease with commit fencing), but the runtime is
  single-machine: no cross-host shared storage or multi-region scheduling.
- Workers AI and Durable Objects are not emulated; KV/D1/R2/Queue/Service
  bindings run through local adapters (`workflows.mbt.json` `adapters`).

## Verification status

The fallback path is exercised by `node compat/run-drill.mjs` — the same
workflow source runs under `wrangler dev` and `workflows.mbt`, the local
runtime is SIGKILLed mid-suspension, and the instance must complete from
persisted state with identical output. Drill records land in
`compat-results/drill-*.json`.

The packaged artifact is additionally exercised end-to-end by
`npm run test:scenario` (`scripts/consumer-scenario.mjs`): a consumer project
with no repository checkout or MoonBit toolchain runs an ordinary Cloudflare
Workflow that calls an external HTTP service with a business idempotency
key. The run proves a retried external side effect (first call 503), a
SIGKILL after the downstream effect was applied but before the step result
committed (the replayed step callback re-executed — at-least-once delivery —
and the downstream service deduplicated on the business key, one applied
record for three calls), a SIGKILL while parked on `waitForEvent`, and
completion after `sendEvent` on the third process. Evidence lands in
`compat-results/scenario-consumer.json`. Exactly-once external delivery is
not claimed anywhere — §4's application-level idempotency requirement is the
mechanism that made the replay safe.
