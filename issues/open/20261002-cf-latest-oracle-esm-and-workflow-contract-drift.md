# Restore the latest cf oracle and investigate Workflow contract drift

Status: open
Priority: P2
Created: 2026-10-02
Observed baseline: `main` @ `c1db2db32c316f3c2c55e3464f9cbf10a07ad1a6`
Related: [PR #19](https://github.com/f4ah6o/workflows.mbt/pull/19), [post-merge triage](https://github.com/f4ah6o/workflows.mbt/pull/19#issuecomment-5950246778)
Parent: [continuous upstream tracking](20260928-upstream-tracking-pipeline.md)

## 1. Problem and evidence

PR #19 is merged and its review findings are resolved. The production-only
`cf/config` import, multiple Workflow binding aliases, and config stdout/JSON
separation have been fixed; they are not remaining work in this packet.

The normal [main CI run 36994682328](https://github.com/f4ah6o/workflows.mbt/actions/runs/36994682328)
completed successfully, including the pinned Cloudflare oracle.
The optional [latest run 36994682408](https://github.com/f4ah6o/workflows.mbt/actions/runs/36994682408)
completed with failure. Its observed verdict is `upstream-execution-failure`.

The latest candidate used:

| Package | Version |
| --- | --- |
| `cf` | `1.0.0-beta.11` |
| `@cloudflare/vite-plugin` | `1.62.4` |
| `vite` | `8.3.2` |
| `@cloudflare/workers-types` | `5.20261002.1` |
| `workerd` | `1.20261002.1` |

Two separate observations need follow-up:

1. The upstream dev server exited with code 1 before readiness while loading
   the temporary oracle's `vite.config.ts`. The error says that
   `@cloudflare/vite-plugin` is ESM-only but was attempted through `require`.
   The differential probes therefore could not establish latest semantic
   compatibility or incompatibility.
2. The contract phase separately failed with
   `Workflow: d4c77dae -> 2a505161`. This is an observed contract fingerprint
   change; the exact changed member/signature and its runtime implications
   have not yet been classified.

Docs-watch also reported three changed upstream sources. That is an
investigation trigger, not by itself a semantic incompatibility result.
Latest coverage correctly remained `INVALID`; the update candidate was not
promoted. Artifacts include `drift-646fd0b9.md`. GitHub Issues is disabled,
so automatic publication was skipped; the artifact-generated
`issues/open/20261002-drift-646fd0b9.md` was not committed to the repository.
This packet makes the remaining work durable in the repository.

## 2. Reproduce and isolate the ESM failure

Use the exact recorded candidate tuple and run evidence/lockfile rather than
re-resolving `latest` for the initial reproduction.

Relevant files:

- `compat/candidate.mjs` — creates the isolated candidate manifest.
- `compat/run-differential.mjs` — copies that manifest into the temporary
  oracle directory and invokes `cf dev`.
- `compat/run-drill.mjs` — uses the same manifest-copy pattern.
- `compat/probes/vite.config.ts` and `fixtures/drill/vite.config.ts`.

The generated latest candidate manifest lacks `"type": "module"`, while the
repository manifest used by the pinned oracle declares it. This difference
is a concrete lead for the ESM/CJS failure, not yet a proven complete cause.

1. Reproduce the failing Vite/config resolution with the isolated candidate.
2. Establish an explicit ESM contract for the oracle config. Options include
   an ESM candidate manifest or an explicit `.mts` config; choose a fix
   that also works for the drill and pinned paths.
3. Add a regression covering the isolated latest-candidate module context.
   A passing test must exercise config/plugin loading, not merely assert
   that the manifest contains a field.
4. Keep candidate acquisition, oracle startup, and semantic probe failures
   distinguishable. Do not turn startup failures into compatibility passes.

## 3. Classify the Workflow contract change

1. Inspect the contract result and exact diff against Workers types
   `5.20261002.1`; identify the affected Workflow members/signatures.
2. Classify it as a meaningful supported-surface change, an explicitly
   unsupported upstream feature, or an extractor/normalization issue.
3. If supported behavior changed, implement it in the appropriate host/shim
   or MoonBit durable kernel and add typecheck plus behavioral evidence.
   Preserve unchanged existing Cloudflare Workflow source.
4. If the extractor is wrong, fix it with a regression; do not mask genuine
   drift by refreshing the baseline.
5. Inspect the changed docs-watch sections and reconcile the compatibility
   matrix/documentation with the actual verified support.

## 4. Acceptance and validation

- [ ] The exact recorded latest candidate starts through `cf dev` and loads
      `@cloudflare/vite-plugin` successfully.
- [ ] The isolated latest path and fallback drill have explicit, working ESM
      config loading; the pinned oracle still passes.
- [ ] The Workflow fingerprint change is explained at member/signature level
      with an explicit support decision and any necessary implementation/tests.
- [ ] `npm run test:host`, `npm run test:upstream-ops`,
      `npm run test:compat`, and `npm run compat:typecheck` pass.
- [ ] `npm run compat:pinned` passes without weakening its gates.
- [ ] `npm run compat:latest` completes with full candidate-bound evidence.
      Compatibility is claimed only for a validated `compatible` verdict;
      genuine unresolved drift remains an open finding.
- [ ] `npm run compat:drill` passes for the changed oracle-loading path.
- [ ] Docs-watch changes are classified; baseline changes are reviewed.
- [ ] Latest coverage is valid when the evidence supports it. No missing or
      failed upstream probe is counted as verified.
- [ ] Pin/manifest/lockfile updates are proposed only after the verified
      candidate qualifies for promotion; do not move the baseline just to
      silence the current failure.
- [ ] Final diff review, scope review, and `git status` are recorded.

These validation commands are acceptance requirements, not tests already
performed for the follow-up. At filing time the observed main/pinned CI is
PASS and latest CI is FAIL.

## 5. Scope boundary

This work repairs latest-oracle execution and addresses the observed
upstream contract/docs changes. It does not reopen resolved PR #19 findings,
enable GitHub Issues, provision hosted Cloudflare credentials, change the
durable persistence model, or claim full latest/hosted compatibility without
evidence. The existing parent packet tracks the separate operational gaps.

Re-checked against main @ `664dc3e` (2026-10-09): still open — the ESM oracle
startup and contract-drift fixes are in flight on PR #20 and not yet on main;
latest compatibility remains an open finding.
