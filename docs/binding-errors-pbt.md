# Workflow binding error-shape PBT

This standalone regression suite checks two observable Cloudflare local binding contracts:

- Looking up an absent instance (`get(id)` followed by `status()`) rejects with a message containing `instance.not_found`.
- Creating an already existing ID rejects with a message starting with `(instance.already_exists)`.

The synthetic fixture is shared between the Node runtime and credential-free Wrangler local runtime. It does not use other storage bindings or deploy a Worker. These message assertions characterize the pinned local implementation, not a documented guarantee for every hosted Cloudflare version.

## Run

After `npm ci` and `npm run build:core`:

```sh
npm run test:binding-errors:pbt
WORKFLOWS_BINDING_BACKEND=cloudflare npm run test:binding-errors:pbt
```

The first command is a real failing regression suite until the runtime error shapes are fixed. It is exposed as a dedicated script and is not added to the default `npm test` command. No `skip`, `todo`, or expected-failure wrapper masks the failures.

The generator produces IDs of 1–100 characters from lowercase letters and digits, and 2–8 total create attempts. The duplicate property creates the first instance before launching the remaining attempts concurrently. This isolates duplicate error shape from the separate question of atomicity when all first creates race. Each generated or shrunk duplicate case cleans up its instance before the next case.

## Shrink and replay

fast-check reports the seed, shrink path, counterexample and shrink count. The default seed is `20261005`, with up to 100 cases per property. On the current runtime, the missing failure shrinks to `["a"]` and the duplicate failure to `["a", 2]`.

Replay only the selected property when using `FC_PATH`:

```sh
FC_SEED=20261005 FC_PATH=0:0:0 node --test --test-name-pattern='missing instance' tests/binding-errors.pbt.test.mjs
FC_SEED=20261005 FC_PATH=0:0:0:0 node --test --test-name-pattern='duplicate creates' tests/binding-errors.pbt.test.mjs
```

Use the seed/path printed by your run if they differ. `FC_RUNS` changes the case budget. See the [fast-check runner documentation](https://fast-check.dev/docs/core-blocks/runners/) for reporting and runner behavior.

Validation on 2026-10-05 with fast-check 4.10.2, Wrangler 4.141.0 and workerd 1.20260925.2: Cloudflare local passed both properties (100 cases each). The Node runtime failed both, shrinking the missing counterexample twice and the duplicate counterexample three times. Both reported seed/path pairs replayed the minimized failure with no additional shrinking.

The comparison covers rejection messages, successful create count, error count and returned winner ID. It does not certify hosted behavior, Workflow execution status, recovery code, or every possible instance-ID character.
