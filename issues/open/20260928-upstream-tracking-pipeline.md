# Continuous upstream tracking: shared candidate, verdict, response packets, update candidates

Status: open (implemented this session; remaining operational gaps below)
Created: 2026-09-28
Baseline: origin/main @ 952f5c4 (post-PR #8)

## What was implemented

A1 — one shared candidate per run (`compat/candidate.mjs`). `latest` resolves
`@latest` for wrangler / `@cloudflare/workers-types` / workerd **once** at run
entry into an isolated install under `compat-results/candidate-latest/` — the
repo's `node_modules`/lockfile are never dirtied. The record carries exact
versions, registry `integrity`/`resolved` hashes, and the real transitive
runtime graph (`npm ls`): the miniflare/workerd the run actually executed.
`compatibility_date`/`compatibility_flags` are recorded as verification
conditions. `pinned` resolves the same record shape from the repo lockfile.
`check.mjs`, `run-differential.mjs`, `run-drill.mjs`, `run-typecheck.mjs` all
consume `--candidate` or the persisted `candidate-<mode>.json`.

A2 — machine-readable verdict (`compat/verdict.mjs`): `compatible`,
`contract-drift`, `semantic-drift`, `upstream-acquisition-failure`,
`upstream-execution-failure`, `local-runtime-failure`,
`incomplete-evidence`, `hosted-not-performed`. Result files are rejected on
missing file / malformed JSON / missing fields / disagreeing runIds or
candidateIds / partial probe coverage / a phase recorded as
acquisition-failure. `run-latest.mjs` orchestrates all phases under one
`WORKFLOWS_MBT_RUN_ID` and always leaves complete evidence.

A3 — response path (`compat/drift-record.mjs` rewritten). Dedup key hashes
oracle + contract paths + probe ids only (problem identity); version tuples
accumulate in `versionsSeen`. `drift-state.json` tracks open → resolved →
recurred. Packet includes fix candidates, capability mapping, observed vs
pinned tuples, repro, unconfirmed items. Every packet is also upserted into
`issues/open/<yyyymmdd>-<key>.md` — the repo's durable md-issue convention —
plus `compat-results` for CI artifacts. `--publish` checks `has_issues` and
records skipped/failed/created/commented in `publish-<key>.json`; `--dry-run`
and `--mock-dir` make the publisher testable without an API. Comments only on
material change.

A4 — verified update candidates (`compat/update-candidate.mjs`). Emits
`proposed-manifest.json` only on a `compatible` verdict; `blocked` with
`requiresImplementationChange` on drift; `no-update` on upstream failure.
Applying is manual; nothing promotes the baseline automatically and
`compatibility_date` is never bundled.

A5 — docs watch (`compat/docs-watch.mjs`): hashes the official doc URLs cited
by `compat/cloudflare/VERSION.md` against `compat/docs-watch.baseline.json`;
a change is an investigation trigger recorded on the verdict. Baseline refresh
is manual only.

B — practical scenario (`examples/scenario/` + `scripts/consumer-scenario.mjs`,
`npm run test:scenario`): external HTTP side effect → retry on 503 →
waitForEvent → two SIGKILLs (post-effect/pre-commit; while waiting) → restart
→ complete. The business idempotency key (orderId) dedups the replay:
3 charge calls, 1 applied record. Evidence: `compat-results/scenario-consumer.json`.

## Validation

`tests/upstream-ops.test.mjs` (`npm run test:upstream-ops`, 11 tests) — hermetic
fault injection over `WORKFLOWS_MBT_RESULTS_DIR`: shared-candidate binding,
verdict taxonomy incl. registry failure injection, missing/malformed/partial
evidence rejection, dedup by problem identity, publish outcome honesty,
update-candidate promotion rules, real transitive runtime graph.

## Remaining gaps

- GitHub Issues is **disabled** on this repo (`has_issues: false`). The
  publish path is implemented and prechecks it, but the real create/comment
  flow is unexercised — only mock-dir evidence exists. Enabling Issues is a
  repo-settings decision (was explicitly out of scope).
- Hosted canary (`compat-hosted.yml`) remains credential-gated and never ran;
  `hosted-not-performed` verdicts are correct but hosted coverage is absent.
- `docs-watch` fetches developer docs pages; hash noise (A/B, timestamps) may
  produce false "changed" signals — investigated-by-hand design, may need
  content-section extraction if it proves noisy.
- `update-candidate` proposal covers the pin tuple only; lockfile/package.json
  regeneration is a documented manual step, not automated.
