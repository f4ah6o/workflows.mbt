# Migrating workflows.mbt projects from Wrangler to cf

Cloudflare's `cf` CLI uses `cloudflare.config.ts` as the typed project
configuration surface. workflows.mbt treats that config as the primary local
runtime input and keeps Wrangler JSON/JSONC support only as a migration
compatibility path.

## Wrangler project

A typical Workflow project previously declares the Workflow in
`wrangler.jsonc`:

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

## Run the Cloudflare migration

Use Cloudflare's migration command with the Vite bundler so the project moves
away from Wrangler as the development/build frontend:

```bash
npx cf migrate --bundler vite
```

Cloudflare's migration currently reports Workflows as manual follow-up work.
Complete that follow-up in `cloudflare.config.ts` by declaring the Workflow
export and the matching binding:

```ts
import { bindings, defineConfig, exports } from "cf/config";

const workerName = "example";

export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",

    env: {
      MY_WORKFLOW: bindings.workflow({
        name: "my-workflow",
        worker: workerName,
        exportName: "MyWorkflow",
      }),
    },

    exports: {
      MyWorkflow: exports.workflow({
        name: "my-workflow",
      }),
    },
  },
});
```

The Workflow implementation source does not need to change. It may continue to
import `WorkflowEntrypoint`, `WorkflowStep`, and `WorkflowEvent` from
`cloudflare:workers`, and `NonRetryableError` from
`cloudflare:workflows`.

## Development and fallback

Use Cloudflare normally through `cf`:

```bash
npx cf dev
```

Run the same project with workflows.mbt when the independent fallback runtime
is required:

```bash
npx workflows doctor --config cloudflare.config.ts
npx workflows dev --config cloudflare.config.ts
```

If `cloudflare.config.ts` is in the current working directory, workflows.mbt
discovers it automatically:

```bash
npx workflows doctor
npx workflows dev
```

Context-aware config factories are resolved with Cloudflare's own config
loader. Use the same mode concept as `cf`:

```bash
npx workflows dev --mode staging
```

## Runtime mapping

workflows.mbt consumes the following `cloudflare.config.ts` concepts:

| Cloudflare config | workflows.mbt |
| --- | --- |
| `worker.name` | worker/project name |
| `worker.entrypoint` | unchanged Worker/Workflow source entrypoint |
| `worker.compatibilityDate` | compatibility date |
| `worker.compatibilityFlags` | compatibility flags |
| `worker.exports.* = exports.workflow(...)` | Workflow class/name declaration |
| `worker.env.* = bindings.workflow(...)` | Workflow environment binding |
| text / JSON bindings | local values |
| secret bindings | required local secret names |
| supported KV / D1 / R2 / queue / worker bindings | local adapter declarations |

Local-only persistence and adapter configuration stays in
`workflows.mbt.json`; it is intentionally not mixed into Cloudflare's
deployment config.

## Legacy Wrangler compatibility

`wrangler.jsonc` and `wrangler.json` remain accepted when explicitly passed
to `--config`, and are discovered only when no `cloudflare.config.ts` is
present. Wrangler environment selection continues to use `--env`.

This compatibility path exists so projects can migrate incrementally. New
workflows.mbt examples, compatibility probes, and fallback drills use
`cloudflare.config.ts` and the `cf` toolchain.
