---
name: testing-workflows-mbt
description: How to drive the workflows.mbt CLI (doctor, dev, lifecycle commands) and its npm-packaged consumer journey when end-to-end testing this repo
---

# Testing workflows.mbt operator surface

Repo: `/home/ubuntu/repos/workflows-mbt`. Node >= 22 required; the MoonBit toolchain at `~/.moon/bin` is only needed to *build* `dist/workflows_core.mjs` — the prebuilt kernel lets doctor/dev run without it.

## CLI entry point

`node host/cli.mjs <command>` (installed consumers get a `workflows` bin).

- `doctor --config <wrangler.jsonc> [--storage <path>] [--build-dir <dir>] [--json]` — staged preflight; prints `ok`/`FAIL`/`skip`/`warn` lines and `doctor: all checks passed`/`doctor: FAILED`. Exit 1 on any FAIL. Always pass `--storage`/`--build-dir` to a scratch path during testing: the storage check **creates** the sqlite file and the bundle check writes bundles under `<config-dir>/.workflows/` otherwise.
- `dev --config <wrangler.jsonc> --port <n> [--storage <path>]` — boots HTTP on 127.0.0.1 and prints `workflows dev listening on http://<host>:<port>` once bound (`--no-http` prints a disabled line instead). Still poll `/health` for readiness.
- `--help`/`help`/`-h` → usage on stdout, exit 0. `--version`/`version` → `<pkg.name> <pkg.version>`, exit 0. Bare invocation or an unknown command → usage on stderr, exit 2 — unknown commands are rejected before `WorkflowRuntime.open`, so they work even in a directory with no `wrangler.jsonc`.

## HTTP surface of `dev`

Requests first hit the Cloudflare-style REST API (`/accounts/<a>/workflows/<wf>/instances/...`), then fall through to the bundled worker's default `fetch` export. `examples/basic` provides `GET /health` (`ok`), `POST /create` (`{"id":..., "params":{...}}` → instance status JSON), `GET /status?id=<id>` → `{"status": "queued|running|waiting|complete|...", "output": ...}`.

## Instance lifecycle for durability tests

`step.sleep` parks an instance as `"waiting"`. To prove resume-from-storage: create → poll until `"waiting"` (poll in the SAME shell command — the window can be ~seconds) → `kill -9` the dev process → restart with the SAME `--storage` path → status reaches `"complete"` with the persisted `output`.

## Packaging

`npm pack` runs `prepack` (stages `npm-shrinkwrap.json` from `package-lock.json`, builds kernel if missing) and `postpack` (removes it). The `files` whitelist ships `dist/ host/ compat/ fixtures/ docs/ examples/ scripts/ src/` plus the manifests, with `!`-negations that keep gitignored runtime state out of the tarball (`.workflows/`, `.wrangler/`, `*.db*`, `.dev.vars*`, `.env*`, `compat-results/`); consumer-smoke asserts none of these appear in the extracted artifact. Stray *tracked-looking* files left under whitelisted dirs still ship — check `npm pack --dry-run --json` output if unsure.

`npm run test:consumer` (`scripts/consumer-smoke.mjs`) is the full clean-machine journey (~1 min, needs npm registry): pack → extract → `npm ci --omit=dev` → doctor → dev → SIGKILL mid-sleep → restart → complete → `npm install <tgz>` + `workflows --version`, all on a PATH without the MoonBit toolchain.
