# Wrangler CLI migration boundary

## Goal

Keep Cloudflare Workflow source and existing operator muscle memory portable while
moving durable execution from `wrangler dev` / Miniflare to `workflows.mbt`.

The smallest stable boundary is:

```text
official Wrangler CLI
  command parsing / validation / presentation
             |
             | HTTP: /cdn-cgi/local/explorer/api/workflows/...
             v
workflows.mbt host
  Wrangler local API adapter
             |
             v
MoonBit durable runtime + storage
```

## Why not fork Wrangler

Wrangler already implements the user-facing `workflows ... --local` commands
and sends them to a documented-by-implementation local explorer HTTP surface.
Reimplementing that parser, help text, JSON rendering, lifecycle flags, and
future command additions would create a second compatibility problem.

Instead, `workflows dev` exposes the same Workflows-local API that Wrangler
uses when `--local` is selected. The installed upstream Wrangler remains the
client.

This gives operators a narrow runtime migration:

```text
execution:
  npx wrangler dev
       ->
  workflows dev --config wrangler.jsonc

management:
  npx wrangler workflows ... --local
       ->
  unchanged
```

## Cloud Foundry CLI reference

The Cloud Foundry CLI is used as an architectural reference, not a dependency.
Its command parser separates command selection from command setup/execution and
from UI output. The useful property for workflows.mbt is the boundary, not the
Go implementation or Cloud Foundry API client:

- command parsing and presentation belong to the CLI frontend;
- execution semantics belong behind a stable backend interface;
- backend compatibility can be tested without cloning the frontend.

For workflows.mbt, upstream Wrangler is the command/parser/UI frontend and the
local explorer HTTP contract is that backend interface.

## Supported local Workflows routes

`workflows dev` handles these Wrangler local-explorer routes:

- `GET /workflows`
- `GET|DELETE /workflows/:workflow`
- `GET|POST /workflows/:workflow/instances`
- `POST /workflows/:workflow/instances/batch/delete`
- `GET|DELETE /workflows/:workflow/instances/:id`
- `PATCH /workflows/:workflow/instances/:id/status`
- `POST /workflows/:workflow/instances/:id/events/:type`

All are rooted at `/cdn-cgi/local/explorer/api`.

The adapter reuses the existing workflow bindings, lifecycle methods, durable
storage, and serialization. It does not introduce a parallel workflow engine.

## Compatibility guard

`tests/wrangler-local.test.mjs` has two layers:

1. direct contract tests for the local explorer route behavior;
2. a smoke test that launches the repository's pinned, real Wrangler CLI and
   runs `wrangler workflows list --local` against a workflows.mbt HTTP server.

This keeps parser/rendering behavior owned by upstream Wrangler while verifying
that the network boundary remains interoperable.
