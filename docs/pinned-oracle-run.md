# Pinned oracle run (P0 evidence)

`npm run compat:pinned` resolves a fresh pinned candidate, checks both the repository's TypeScript fixture and candidate-scoped types, performs the Cloudflare contract and differential probes, validates the capability matrix, and writes `compat-results/verdict-pinned.json`.

All phases share one `WORKFLOWS_MBT_RUN_ID`. A failing phase does not prevent later phases from writing diagnostic evidence. The command succeeds only when **every phase exits successfully** and the verdict is `compatible`, with matching oracle and run ID. Missing, malformed, mismatched, or stale verdicts cannot turn a failed run into success.

The pinned tuple is defined by `compat/oracle/manifest.json`. Latest and hosted oracles are separate evidence and are not implied by a pinned PASS. A PostgreSQL storage PASS is claimed only when `WORKFLOWS_POSTGRES_URL` is configured for the storage tests (as in the service-backed CI job), not when that suite skips PostgreSQL.

For differences or acquisition failures, inspect `compat-results/verdict-pinned.json` and the phase-specific result files; do not refresh baselines merely to silence drift.

`compat:report` revalidates coverage freshness before displaying a pinned verdict. The shared evidence fingerprint includes the oracle manifest and contract baselines, the complete typecheck fixture/config directory, verification scripts, dependency manifests/lockfile and MoonBit toolchain pin, in addition to runtime/probe inputs. Changing any of these invalidates saved evidence; older fingerprints without these verification hashes are also `STALE` and require a new run. The verdict must additionally match the validated evidence's run ID and candidate ID. Unrelated documentation changes do not invalidate evidence.
