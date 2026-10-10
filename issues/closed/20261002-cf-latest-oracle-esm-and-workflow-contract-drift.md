# Latest cf oracle: createBatch contract and ctx.tracing drift

Status: closed (resolved by PR #20, merged 2026-10-10)
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

- [x] The exact recorded latest candidate starts through `cf dev` and loads
      `@cloudflare/vite-plugin` successfully.
- [x] The isolated latest path and fallback drill have explicit, working ESM
      config loading; the pinned oracle still passes.
- [x] The Workflow fingerprint change is explained at member/signature level
      with an explicit support decision and any necessary implementation/tests.
- [x] `npm run test:host`, `npm run test:upstream-ops`,
      `npm run test:compat`, and `npm run compat:typecheck` pass.
- [x] `npm run compat:pinned` passes without weakening its gates.
- [x] `npm run compat:latest` completes with full candidate-bound evidence.
      Compatibility is claimed only for a validated `compatible` verdict;
      genuine unresolved drift remains an open finding.
- [x] `npm run compat:drill` passes for the changed oracle-loading path.
- [x] Docs-watch changes are classified; baseline changes are reviewed.
- [x] Latest coverage is valid when the evidence supports it. No missing or
      failed upstream probe is counted as verified.
- [x] Pin/manifest/lockfile updates are proposed only after the verified
      candidate qualifies for promotion; do not move the baseline just to
      silence the current failure.
- [x] Final diff review, scope review, and `git status` are recorded.

These validation commands are acceptance requirements, not tests already
performed for the follow-up. At filing time the observed main/pinned CI is
PASS and latest CI is FAIL.

## 5. Scope boundary

This work repairs latest-oracle execution and addresses the observed
upstream contract/docs changes. It does not reopen resolved PR #19 findings,
enable GitHub Issues, provision hosted Cloudflare credentials, change the
durable persistence model, or claim full latest/hosted compatibility without
evidence. The existing parent packet tracks the separate operational gaps.

## 6. Oracle repair and reproduced remaining drift (2026-10-02)

The startup repair uses explicit `vite.config.mts` files for both
`compat/probes` and `fixtures/drill`. Vite discovers these as ESM even when
an isolated candidate manifest omits `type: module`. The relevant-input
fingerprint now hashes the renamed probe config. Regression tests load the
real Cloudflare plugin with Vite in a temporary CommonJS package context.
Both pinned Vite 7.3.6 and the originally failing Vite 8.3.2 pass these tests.
No dependency pin, contract snapshot, capability claim, or coverage target
was changed. The consumed PR #19 pin-migration waiver is removed: against
the post-merge base it matches no regression and rejects every subsequent
PR. The gate still rejects unused waivers and unwaived regressions.

The drill also exposed a pre-existing result-writing bug: its record
initializer accessed `record.commit` before initialization. Build the
fingerprint after constructing the record so completed crash/restart
verification can be saved.

The exact original package tuple was installed in an isolated reproduction
directory and run through `cf dev`: both sides completed all 32 differential
probes, with no startup or probe errors. The semantic result is FAIL for
`entrypoint-ctx`; the other 31 probes match. A fresh `npm run compat:latest`
run (`latest-2026-10-02T11-34-36-727914`) independently reproduces that result.
Its top-level Wrangler is 4.147.0; the cf runtime graph uses Wrangler 4.146.0.
Its verdict is `contract-drift`, with the semantic mismatch also present in
the phase evidence. Candidate promotion remains blocked.

### Remaining contract work

Workers types 5.20261002.1 add this `Workflow.createBatch` overload:

```ts
createBatch(options: WorkflowBatchCreateOptions<PARAMS>): Promise<WorkflowBatchCreateResult>;
```

`WorkflowBatchCreateOptions` is either `{ count, params?, retention?,
locationHint? }` or `{ instances: WorkflowInstanceCreateOptions[] }`.
The result is `{ created: WorkflowInstance[], errors: { index, id?, code,
message }[] }`. The existing array overload remains but is deprecated.
This is a genuine supported binding-surface addition, not a comment-only
hash change or an extractor defect. `host/binding.mjs` currently accepts
only arrays, so the object forms need implementation and candidate-bound
behavioral tests covering generated IDs, duplicate IDs, indexed partial
errors, validation, retention, and hints. Track the new options/result
shapes in the contract extractor and upstream inventory before reviewing
promotion. Do not merely refresh the Workflow hash.

### Remaining semantic work

Inside `WorkflowEntrypoint.run`, latest Cloudflare reports
`ctx.tracing.getActiveSpan()` present outside tracing callbacks. After both
`enterSpan` and `startActiveSpan` callbacks settle, that invocation span is
restored. The pinned/local default has no active span in those positions.
The original packet had these facts reversed: its probe booleans test
`getActiveSpan() === undefined`, so `true` means **absent**, not present.
The same probe passes against the pinned oracle, so this is a versioned
runtime behavior change. Add targeted tests and a deliberate compatibility
policy for both supported oracle versions; do not normalize these fields
away to obtain a pass. See `host/execution-context.mjs` and the
`entrypoint-ctx` probe in `compat/probes/src/index.ts`.

Docs-watch still reports three changed sources; their semantic
classification and baseline review remain open. Latest compatibility and
latest coverage are not claimed by this repair.

### Validation of the repair

- PASS: `npm run build:core`
- PASS: `npm run test:host`, `npm run test:upstream-ops`, `npm run test:compat`
- PASS: `npm run compat:typecheck`, `npm run compat:pinned`
- PASS: `npm run compat:drill` (pinned), and the exact original candidate
  drill: upstream output matches fallback after process kill/restart; the
  record and fingerprint are saved.
- PASS: `npm run test:coverage`, `npm run test:upstream-coverage`.
- PASS: real plugin config loading against both pinned and exact-original
  candidate dependencies (`tests/oracle-config.test.mjs`).
- FAIL (genuine remaining drift): `npm run compat:latest` and the exact
  original candidate differential run, as described above.

This packet stays open for the contract, tracing, and docs follow-up.

## 2026-10-04 follow-up: explicit supported behavior

The local host adds both object forms of `createBatch` while preserving the
legacy array result. Candidate-bound tests cover generated IDs, duplicate
position errors, pre-creation validation, retention and location hints.
The new union/result declarations are extracted in full, including both union
arms. The pinned API snapshot, dependency pins and capability coverage claims
are unchanged. A separate exact-version contract profile records the reviewed
5.20261004.1 extension; an unknown future signature remains drift.

Tracing now has explicit local policy: `compatibility.tracingScope` in
`workflows.mbt.json` or `--tracing-scope`, with `callback` as the pinned default
and `invocation` for the observed October oracle. Differential evidence records
the selected policy and includes its selector in freshness hashing. Raw span
presence/restoration fields remain unnormalized. This is context propagation,
not trace recording/export; local spans remain `isTraced: false`.

The new batch probe only runs when the resolved workers-types candidate supports
the overload. It does not increase pinned capability/coverage claims. Real
hosted deployment behavior has not been tested. The latest cf dev loopback
`ctx.exports` object-overload wrapper can throw `results.map is not a function`
after creating instances; the batch contract probe targets the normal workflow
environment binding. The local implementation does not reproduce that upstream
loopback bug.

### Docs-watch review

All five changed Workflows sections and the Wrangler sample configuration are
date-only churn: replacing the example date with 2026-09-29 reproduces their
baseline hashes. The `createBatch`, context/tracing and Wrangler workflows
sections have unchanged hashes. Other changed/added Wrangler sections concern
platform/deployment configuration (workers.dev/preview defaults, Durable Object
exports/migrations, Analytics SQL, telemetry and Containers), outside this
runtime fix. The new cf source is watch coverage from the earlier cf migration.
Those entries remain advisory and are not silently rebaselined; historical
prose is unavailable for exact textual comparison because the baseline stores
hashes. No dependency promotion or hosted equivalence is claimed.

The dedicated real-`cf dev` tracing regression passes for pinned Vite plugin
1.62.0 (`callback`), original 1.62.4 (`invocation`), and current 1.62.5
(`invocation`), all with compatibility date 2026-09-26. The exact same scope
observation runs upstream and locally, comparing raw ambient-span presence,
identity/restoration, nested callbacks, awaits, concurrent branches, synchronous
throws, asynchronous rejections and detached spans. The original reproduction
uses cf 1.0.0-beta.11, Vite 8.3.2, workers-types 5.20261002.1 and workerd
1.20261002.1 with a fresh isolated transitive lock; the historical run's lockfile
was not recovered. This establishes tracing scope for that installed graph,
not equivalence to every dependency of the historical run.


### Payload edge found during final review

The October oracle accepts BigInt, cyclic and function-containing batch payloads
at creation, while Symbol payloads fail RPC cloning before any instance exists.
The host's existing workflow-params persistence remains JSON-only. Object batches
now preflight and snapshot all locally serializable params before any storage
write, preventing partial creation when a later payload is unsupported. This is
a safe failure policy, not a claim of upstream non-JSON payload compatibility;
that pre-existing serialization gap remains outside this JSON binding fix.

### Validation of the follow-up

- Pinned differential: PASS, 32/32 probes, unchanged dependency pins.
- Latest differential: PASS, 33/33 probes, candidate `latest-8ba0fe15d5c0e4ba`
  (cf beta.12 / Vite plugin 1.62.5 / Vite 8.3.2 / Wrangler 4.147.0 /
  workers-types and top-level workerd 20261004.1), with explicit invocation
  tracing policy. Full latest orchestration also passed all nine phases.
- Final host suite: 41 PASS, including nine batch and eight tracing regressions.
- `npm test`: PASS (MoonBit 6, E2E 52, SQLite 17; PostgreSQL skipped locally
  because no service URL was configured). CI provides the PostgreSQL service.
- Candidate typecheck regression: 4 PASS, including deliberate global-declaration
  and new-batch-signature corruption. Fixed candidate typechecking to select its
  ambient declarations explicitly; TypeScript `types` does not honor `paths`.
- Consumer smoke, practical crash/retry scenario, pinned/latest crash-restart
  drills: PASS. The latest drill was retried after a concurrent candidate refresh
  briefly removed runtime assets; the final run passed.
- Pinned-only coverage regression gate: PASS, as in PR CI. Combined latest
  coverage promotion is intentionally not performed: its proposed baseline has
  no accepted latest candidate yet. Capability denominators/claims and strict
  waiver matching are unchanged.
- Hosted Cloudflare verification: not run; no deployment or merge performed.

Re-checked against main @ `664dc3e` (2026-10-09): still open — the ESM oracle
startup and contract-drift fixes are in flight on PR #20 and not yet on main;
latest compatibility remains an open finding.

## 2026-10-10 re-check: verified, `compatible` verdict on this branch

Full acceptance suite run on the branch (commit `a778142`).

### Results

- `npm test`: PASS — MoonBit 6, host 41, SQLite storage 17 (PostgreSQL suite
  skipped: no `WORKFLOWS_POSTGRES_URL`), compat 14, upstream-ops 20,
  inventory 13, coverage 17, upstream-coverage 8, e2e 53.
- `npm run compat:typecheck`: PASS.
- `npm run compat:pinned`: PASS — contract `contract-pinned-1791636285937`,
  differential 32/32, no gates weakened.
- `npm run compat:drill`: PASS — `drill-pinned-1791635812184`; latest drill
  also PASS (`drill-latest-1791636144144`, outputs match after kill/restart).
- `npm run compat:latest`: PASS, verdict **`compatible`** — run
  `latest-2026-10-10T12-44-07-070e37`, candidate `latest-03496bff7c145cbd`
  (cf 1.0.0-beta.14 / vite-plugin 1.63.1 / vite 8.3.4 / wrangler 4.149.0 /
  workers-types+workerd 20261010.1). All nine phases exit 0: contract clean,
  differential 33/33 with 0 differences and 0 probe errors, typecheck pass.
  Every probe completed; nothing counted as verified on missing evidence.
- `update-candidate`: `status: proposed` — a pin/manifest/lockfile proposal
  (`compat-results/update-candidate.patch`) was generated for review only;
  nothing applied. Promotion remains a separate decision, not part of this fix.
- Final `git status` on the branch: only the intended modifications
  (see "Changes since the 2026-10-04 follow-up") plus this issue file;
  generated `issues/open/20261010-drift-*.md` packets were deleted —
  artifact packets are not committed per convention.

### Changes since the 2026-10-04 follow-up

The first re-check run of `compat:latest` reported `contract-drift` against
today's registry `latest` — upstream had moved past the follow-up's verified
tuple. Both observations were re-verified against the installed candidate,
not just rebaselined:

- `workers-types` `5.20261010.1` carries the *identical* reviewed surface:
  extracted `Workflow` `2a505161`, `WorkflowBatchCreateOptions` `75c57f63`,
  `WorkflowBatchCreateResult` `fd7fd0e2` — byte-identical hashes to the
  `5.20261004.1` profile. `batch-create-surface.json` now lists both verified
  versions; an unknown future signature still reports as drift.
- `vite-plugin` `1.63.1` keeps the October invocation tracing scope:
  differential evidence showed ambient span present + restored after both
  callback forms, and the real-`cf dev` regression test passes against the
  installed candidate (`WORKFLOWS_MBT_TRACING_CANDIDATE` run: ambientPresent,
  ambientStable, all enterSpan/startActiveSpan observations match the local
  `invocation` policy). `tracingScopeFor` and `verifiedScopes` now register
  `1.63.1` → `invocation`; unobserved versions still default to `callback`.

### Docs-watch (this run)

4 sources changed, still advisory (`investigationRequired`, not a compat
failure): new `createbatch` + `batch-multiple-workflow-invocations` sections
document the implemented overload — semantically consistent. Changed
`declare-workflows-in-exports`, `call-workflows-from-workers`,
`cross-script-calls`, `workers-api-bindings`,
`schedule-a-workflow-directly` sections and the Wrangler configuration
sections (analytics/k2/containers/scheduling/ssh etc.) are
platform/deployment documentation outside this runtime fix. Hash-only
baseline; not rebaselined — baseline refresh belongs to candidate promotion.

### Environment note

Local `npm` 11.19 dedupes the optional `@cloudflare/workers-types` peer under
`@cloudflare/vite-plugin` to the pinned `5.20260925.2`, producing an
`invalid` marker that makes `npm ls --json --all` exit 1 and fails
`upstream-ops` ("pinned candidate records the real transitive runtime
graph"). The lockfile is correct; installing with npm 10 (`npx npm@10 ci`,
matching CI's Node 22) restores the nested `5.20261001.1` copy and the suite
passes. No repo change made; CI is unaffected.

### Remaining open

- Candidate promotion: proposal generated, not applied — review + separate PR.
- Docs-watch baseline refresh pending promotion; entries stay advisory.
- Hosted Cloudflare verification still not performed; no deployment or merge.
