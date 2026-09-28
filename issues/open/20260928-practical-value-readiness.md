# Practical-value readiness — install, preflight, and an honest consumer path

Status: open
Created: 2026-09-28
Baseline: main @ 18c79c169470a094baf72588315e8fbdab3f1e79

## Goal

Move the repository from "compatibility-hardened code" to a state where someone
who actually runs Cloudflare Workflows can obtain, install, preflight, run, and
recover `workflows.mbt` as a dependency-risk fallback — without a repository
checkout and without a MoonBit toolchain on the consumer machine.

Evaluation criterion: can a real user install it, run it, cut over during an
outage, inspect state, restart safely, and operate it — not how many
compatibility checkboxes exist.

## Current user journey (observed at baseline)

1. Discovery: README explains the architecture well but documents **only** a
   checkout flow (`npm install` + `npm run build:core`, which requires the
   MoonBit toolchain). There is no install path for non-checkout consumers.
2. `package.json` is `private: true` with a `bin` entry but no `files`
   whitelist. `npm pack` therefore (a) silently omits `dist/` because `.gitignore`
   excludes it — the produced tarball cannot start the runtime without MoonBit —
   and (b) ships development content (`.github/`, `issues/`, `tests/`).
3. `.github/workflows/release.yml` builds a hand-rolled tar that does include
   `dist`, but its contents are not the same as `npm pack` output, no `v*`
   runtime release exists yet, and the artifact has no lockfile —
   `npm ci --omit=dev` inside the extracted artifact cannot work.
4. CLI surface: `dev/trigger/status/event/pause/resume/restart/terminate` exist.
   `--help` prints usage but exits 2. `--version` does not exist. There is no
   preflight/`doctor` command: an operator cannot validate config, secrets,
   storage writability, adapters, bundling, or the kernel before cutover.
5. `docs/fallback-runbook.md` drifted from the implementation: it tells artifact
   consumers to run `npm run build:core` (requires MoonBit — wrong; the artifact
   ships a prebuilt kernel), and lists persisted `ReadableStream` output and
   multi-process executor leases as unimplemented (both landed 2026-09-28).
   README "Scope"/"Compatibility status" carry the same stale claims.
6. No test exercises the real consumer journey (artifact -> clean directory ->
   production deps -> consumer project -> CLI -> crash/restart). The release
   workflow verifies the drill from an extracted tree but never installs the
   artifact the way a consumer would.

## Observed blockers (ranked)

- **P0 — distribution is broken/misleading.** `npm pack` produces a runtime-
  broken tarball (no `dist/`). Documented install path does not exist.
- **P0 — no executable proof of the consumer journey.** The claim "artifact
  works without checkout or MoonBit" is untested.
- **P1 — no preflight command.** Operators cannot detect config/secret/
  storage/adapter/kernel problems before routing traffic.
- **P1 — operational docs describe a runtime that no longer exists.**
  Runbook + README contradict the implementation.
- **P1 — CLI affordances missing:** `--help` exits non-zero, `--version`
  absent.
- **P2 — consumer-facing example project.** `fixtures/` are test harnesses; a
  minimal `examples/basic/` doubles as documentation and as the consumer-test
  workload.
- **P3 — PostgreSQL adapter, hosted canary, broader platform.** Explicitly
  deferred — not practical-value blockers (single-machine SQLite fallback is
  the shipped model; hosted oracle is credential-gated by design).

## Chosen scope

1. Make `npm pack` produce the real runtime artifact:
   `files` whitelist (`dist`, `host`, `compat`, `fixtures`, `docs`, `examples`,
   `scripts`, `src`, `moon.mod.json`, `.moonbit-toolchain.json`), `prepack` that
   builds the kernel and stages `npm-shrinkwrap.json` from the committed
   lockfile (so extracted consumers get `npm ci --omit=dev` determinism), and
   `postpack` cleanup. `package.json` gains `repository`/`description`.
2. `workflows doctor --config wrangler.jsonc` — staged preflight reusing the
   real components (`loadProjectConfig`, `loadKernel`, `SQLiteStorage`,
   `bundleWorkflow`, `loadWorkflowModule`, `buildLocalAdapters`), one line per
   check, non-zero exit on failure, `--json` for machines.
3. CLI affordances: `--help`/`help`/`-h` exit 0 on stdout;
   `--version`/`version` prints the package version.
4. `scripts/consumer-smoke.mjs` + `npm run test:consumer`: pack the artifact,
   extract to a clean temp dir, `npm ci --omit=dev` with a PATH that excludes
   the MoonBit toolchain, run `doctor`, boot `dev` against a consumer project
   (copied from `examples/basic/`), drive an instance to a `step.sleep`
   suspension, SIGKILL, restart from the same storage, require completion and
   matching output; then spot-check `npm install <tgz>` + the `workflows` bin.
5. `examples/basic/` — a minimal, ordinary Cloudflare Workflow +
   `wrangler.jsonc` using `cloudflare:workers` imports unchanged, with the
   small `/health` `/create` `/status` fetch routes the runbook's smoke check
   relies on.
6. `release.yml`: package via the same `npm pack` path consumers use (single
   artifact format), verify by running the consumer smoke against the produced
   tarball instead of a raw checkout-shaped tree.
7. `ci.yml`: add `npm run test:consumer` to normal CI.
8. Docs: README gains an Install section (release artifact -> extract ->
   `npm ci --omit=dev`; or `npm install <tarball>`; no MoonBit needed), CLI
   section documents `doctor`/`--version`, stale Scope/Compatibility claims
   corrected. Runbook §1 split into artifact vs checkout paths + `doctor` as
   the pre-traffic smoke check; §8 stale items removed, real limitations kept.
9. This issue file, referenced by the changes.

## Explicit non-goals

- npm registry publish (external credentials not required; `private: true`
  stays — tarball install is unaffected).
- PostgreSQL/storage-breadth work, hosted canary enablement, Workers AI /
  Durable Objects emulation, full Wrangler clone, in-flight Cloudflare state
  migration.
- Changing the durable-execution model or the storage contract.

## Implementation plan

- `package.json`: `files`, `prepack`/`postpack`, `test:consumer`, metadata.
- `scripts/prepare-pack.mjs`: ensure `dist/workflows_core.mjs` (runs
  `build:core` when missing), copy `package-lock.json` -> `npm-shrinkwrap.json`;
  `--cleanup` removes the staged shrinkwrap.
- `scripts/consumer-smoke.mjs`: the section-8 journey end to end in tmp dirs.
- `host/doctor.mjs` + `host/cli.mjs`: staged checks + help/version.
- `.github/workflows/{release,ci}.yml`: pack-based artifact + CI step.
- `README.md`, `docs/fallback-runbook.md`: current-truth rewrite of the
  affected sections.

## Acceptance criteria

- `npm pack` tarball contains `dist/workflows_core.mjs`,
  `compat/cloudflare-workers/`, `host/`, `npm-shrinkwrap.json`, and none of
  `tests/`, `issues/`, `.github/`.
- From a clean temp dir with no MoonBit on PATH: extract -> `npm ci --omit=dev`
  -> `node host/cli.mjs doctor --config <consumer>/wrangler.jsonc` passes ->
  `dev` serves -> instance created -> SIGKILL mid-sleep -> restart from same
  storage -> `complete` with expected output.
- `npm install <tarball>` into an empty consumer project exposes a working
  `workflows` bin (`--version`).
- `workflows doctor` fails loudly (non-zero) on: missing config, bad
  `class_name`, missing required secret, unwritable storage, missing kernel.
- README and runbook match verified behavior; stale "not implemented" claims
  removed; real limitations (in-flight migration, at-least-once effects,
  single-machine scope, unsupported bindings) remain documented.
- `npm test`, `compat:pinned`, `compat:drill` unchanged and passing.

## Validation plan

- `npm run test:consumer` (the new journey test).
- `npm test`, `npm run compat:pinned`, `npm run compat:drill` on the working
  tree before commit; `compat:latest` recorded as run/not-run with reason.
- `npm pack --dry-run` output inspected for contents.
- Doctor negative paths exercised against deliberately broken configs.
