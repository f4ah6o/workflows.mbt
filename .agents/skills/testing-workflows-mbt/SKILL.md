---
name: testing-workflows-mbt
description: How to drive the workflows.mbt CLI (doctor, dev, lifecycle commands) and its npm-packaged consumer journey when end-to-end testing this repo
---

# Testing workflows.mbt operator surface

Repo: `/home/ubuntu/repos/workflows-mbt`. Node >= 22 required; the MoonBit toolchain at `~/.moon/bin` is only needed to *build* `dist/workflows_core.mjs` — the prebuilt kernel lets doctor/dev run without it.

## CLI entry point

`node host/cli.mjs <command>` (installed consumers get a `workflows` bin).

- `doctor --config <wrangler.jsonc> [--storage <path>] [--build-dir <dir>] [--json]` — staged preflight; prints `ok`/`FAIL`/`skip`/`warn` lines and `doctor: all checks passed`/`doctor: FAILED`. Exit 1 on any FAIL. Always pass `--storage`/`--build-dir` to a scratch path during testing: the storage check **creates** the sqlite file and the bundle check writes bundles under `<config-dir>/.workflows/` otherwise.
- `dev --config <wrangler.jsonc> --port <n> [--storage <path>]` — boots HTTP on 127.0.0.1. **Prints no startup/listening output** — poll `/health` for readiness.
- `--help`/`help` → usage on stdout, exit 0. `--version`/`version` → `<pkg.name> <pkg.version>`, exit 0. Bare invocation → usage on stderr, exit 2. Unknown commands usually crash with an uncaught stack and exit 1 (they open the runtime and resolve workflow/instance before the unknown-command fallback).

## HTTP surface of `dev`

Requests first hit the Cloudflare-style REST API (`/accounts/<a>/workflows/<wf>/instances/...`), then fall through to the bundled worker's default `fetch` export. `examples/basic` provides `GET /health` (`ok`), `POST /create` (`{"id":..., "params":{...}}` → instance status JSON), `GET /status?id=<id>` → `{"status": "queued|running|waiting|complete|...", "output": ...}`.

## Instance lifecycle for durability tests

`step.sleep` parks an instance as `"waiting"`. To prove resume-from-storage: create → poll until `"waiting"` (poll in the SAME shell command — the window can be ~seconds) → `kill -9` the dev process → restart with the SAME `--storage` path → status reaches `"complete"` with the persisted `output`.

## Packaging

`npm pack` runs `prepack` (stages `npm-shrinkwrap.json` from `package-lock.json`, builds kernel if missing) and `postpack` (removes it). The `files` whitelist ships **everything** under `dist/ host/ compat/ fixtures/ docs/ examples/ scripts/ src/` — including gitignored local state like `.workflows/` dirs and any stray files an operator leaves there. Before inspecting a tarball, clean generated state (`rm -rf examples/*/.workflows fixtures/*/.workflows`).

`npm run test:consumer` (`scripts/consumer-smoke.mjs`) is the full clean-machine journey (~1 min, needs npm registry): pack → extract → `npm ci --omit=dev` → doctor → dev → SIGKILL mid-sleep → restart → complete → `npm install <tgz>` + `workflows --version`, all on a PATH without the MoonBit toolchain.
