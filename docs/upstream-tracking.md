# Upstream tracking operations

How workflows.mbt tracks the Cloudflare Workflows upstream continuously:
detect drift, assess impact, leave a reproducible response packet, propose a
verified update candidate, and only move the verified baseline by hand.

## The pipeline

`npm run compat:latest` (`compat/run-latest.mjs`) executes one run under a
single `WORKFLOWS_MBT_RUN_ID`:

1. **candidate** (`compat/candidate.mjs --mode latest --refresh`) — resolves
   `@latest` for wrangler / `@cloudflare/workers-types` / workerd **once** at
   run entry into an isolated install under `compat-results/candidate-latest/`
   (never the repo's `node_modules` or lockfile). The record carries exact
   versions, `dist.integrity`/`resolved` tarball hashes, and the **real
   transitive runtime graph** (`npm ls` over the isolated install): the
   miniflare/workerd that `wrangler dev` actually ran — not a separately
   fetched workerd. The same step with `--mode pinned` resolves the repo's
   lockfile tuple instead, and both modes record `compatibility_date` /
   `compatibility_flags` as verification conditions.
2. **typecheck** (`compat/run-typecheck.mjs`) — compiles the contract fixture
   against the candidate's `@cloudflare/workers-types` via a generated
   tsconfig `paths` redirect.
3. **contract** (`compat/oracle/check.mjs`) — API-surface drift
   (`added`/`removed`/`changed`) against the candidate's unpacked packages.
4. **differential** (`compat/run-differential.mjs`) — the probe catalog under
   the candidate's wrangler binary vs workflows.mbt.
5. **docs-watch** (`compat/docs-watch.mjs`) — hashes the official doc pages
   cited by `compat/cloudflare/VERSION.md` against
   `compat/docs-watch.baseline.json`. A changed page is an investigation
   trigger, never a compatibility failure. Baseline refresh is manual:
   `node compat/docs-watch.mjs --update-baseline`.
6. **verdict** (`compat/verdict.mjs`) — the machine-readable classification
   (below). This is the run's exit status.
7. **response** (`compat/drift-record.mjs`) — deduplicated drift packet +
   `drift-state.json` tracking.
8. **update-candidate** (`compat/update-candidate.mjs`) — a verified pin
   proposal, or an explicit blocked/no-update record.

Every phase writes its own result file even on failure, so a later reader can
never mistake a stale success for current evidence.

## Verdicts

`compat-results/verdict-<oracle>.json` distinguishes:

| verdict | meaning |
| --- | --- |
| `compatible` | every phase passed against one shared candidate |
| `contract-drift` | upstream API/type/config surface changed |
| `semantic-drift` | observable probe behavior diverged |
| `upstream-acquisition-failure` | the candidate could not be resolved or installed (registry/network) |
| `upstream-execution-failure` | the upstream side could not start or run probes |
| `local-runtime-failure` | the workflows.mbt side failed to run |
| `incomplete-evidence` | a result file is missing/malformed/stale, phase runIds or candidateIds disagree, or probe coverage is partial |
| `hosted-not-performed` | the credential-gated hosted canary left no result |

Nothing else counts as success: a missing file, a malformed record, a stale
run, a phase that verified a different upstream tuple, or an upstream that
never started all classify as failure states.

## The response path

On drift, `compat/drift-record.mjs` writes `compat-results/drift-<key>.md` —
a packet with the contract delta, failing probes mapped to
`compat/capabilities.json`, observed vs pinned tuples, reproduce commands,
minimal-fix candidates, unconfirmed items, and artifact refs.

- **Dedup by problem, not version**: the key hashes oracle + contract paths +
  failing probe ids only. The same root cause under a new upstream release
  appends the tuple to `versionsSeen` on the same record — it never spawns a
  second one.
- **State, across runs**: two layers. CI restores `drift-state.json` via
  `actions/cache` (keyed per workflow, saved every run) — that sidecar
  carries dedup history *and* publish outcomes (issue numbers,
  `resolutionPublishedAt`). Independently, every committed
  `issues/open/<date>-<key>.md` carries a `<!-- drift-state:{...} -->`
  footer (status, firstSeen, versionsSeen, recurCount, resolvedAt/Under,
  `github.issue`) that rebuilds the same keys on any fresh checkout or
  local run — the footer is the durable truth, the cache/sidecar only
  saves a re-derivation. Status flows `open` → `resolved` (flipped only
  by complete positive evidence; a `recurred` record resolves again)
  → `recurred`. Resolution also flips `Status:` and the footer on the
  committed packet — and routes through `--publish` as comment + close,
  marked by `resolutionPublishedAt` so the two-invocation workflow shape
  posts it exactly once.
- **Destinations**: the packet is always written twice —
  `compat-results/drift-<key>.md` (CI artifact, 30-day retention) and
  `issues/open/<yyyymmdd>-<key>.md`, the repository's durable md-issue
  convention. The issue filename is stable per problem identity: an
  existing `*-<key>.md` is updated in place; a new file is dated by
  first-seen, never by re-observation day. `--publish` additionally
  upserts a GitHub issue, but only after checking `has_issues` on the repo
  — when Issues is disabled, gh is missing, or the token lacks scope, the
  outcome is recorded as `skipped`/`failed` in
  `compat-results/publish-<key>.json`; a publish attempt is never reported
  as a notification success. Test without an API via `--dry-run` or
  `--mock-dir <dir>`; override the issues dir via
  `--issues-dir`/`WORKFLOWS_MBT_ISSUES_DIR`.
- **No notification spam**: one issue per problem identity, derived from
  the issue itself — the footer persists `github.issue`, and comment dedup
  compares the packet body (footer + per-run lines stripped) against the
  issue's latest comment, falling back to the issue body when no comments
  exist (the body IS the packet right after creation). A comment posts
  only on material change — new observed tuple, a status transition
  (open → resolved → recurred), or a body that differs. Identical
  re-observations post nothing even after the sidecar is lost.
  Resolutions post a comment and close the issue — the comment body is
  frozen on the record at transition time, so a retried close on a later
  run dedups against the posted payload; a close failure is a retryable
  partial failure, never stamped as delivered — and a recurrence clears
  `resolutionPublishedAt` and reopens the issue, so
  resolve → recur → resolve republishes. `--mock-dir` runs the same
  publish state machine against a file-backed issue store, which is how
  the fault-injection suite covers these transitions hermetically.

## Applying an update candidate

When the verdict is `compatible` and the candidate tuple differs from the
pin, `compat-results/proposed-manifest.json` + `update-candidate-latest.json`
hold the proposal. Applying it is manual and reviewable:

```bash
# review compat-results/proposed-manifest.json
# 1. bump the pinned devDependencies in package.json to the candidate tuple
# 2. npm install            (regenerate package-lock.json)
# 3. copy the proposal over compat/oracle/manifest.json
# 4. npm run compat:pinned && npm test   # re-verify under the new pin
# 5. open a PR — never auto-merge, never auto-release
```

A `contract-drift`/`semantic-drift` verdict blocks the candidate with
`requiresImplementationChange` (fix + regression test first). An
acquisition/execution failure yields `no-update` — upstream instability never
moves the baseline. `compatibility_date` bumps are a separate deliberate
change, never bundled into a package update.

## Keeping the watch alive

- Schedule: `.github/workflows/compat-latest.yml` (cron `17 2 * * *` plus
  push triggers on `compat/**`). Confirm it is alive with
  `gh run list --workflow compatibility-latest` — the run summary carries
  the verdict and update-candidate JSON.
- Local rerun: `npm run compat:latest` is self-contained; re-running reuses
  the persisted candidate unless `--refresh` (the orchestrator always
  refreshes).
- Hosted oracle (`compat/canary.mjs`) stays credential-gated in
  `compat-hosted.yml`. Without `CF_API_TOKEN`/`CF_ACCOUNT_ID` the verdict
  reports `hosted-not-performed` — never compatible. No deploy happens
  without an approved disposable environment.
- `WORKFLOWS_MBT_RESULTS_DIR` overrides the evidence dir (the fault-injection
  suite uses it to run every script hermetically against crafted results).
