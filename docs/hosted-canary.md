# Hosted Cloudflare canary — decision record

**Decision:** deferred by default; implemented behind an explicit credential gate.

**Owner:** repository maintainer (see issue `20260926-cloudflare-dependency-insurance`).

**Reason:** the credential-free oracle (`wrangler dev` + workerd, pinned and
latest) already covers the compatibility-critical semantic surface in CI.
Hosted probing adds an account, a secret, and a live deploy target — moving
parts that must not gate normal PR CI. It is implemented but dormant until
credentials are deliberately provisioned.

**Review trigger:** enable before the first release that is expected to serve
as an emergency fallback artifact, after any Cloudflare-reported behavioral
change that `wrangler dev` cannot reproduce, or at the next quarterly
compatibility review — whichever comes first.

## Enabling the canary

1. Create an API token with Workers Scripts write permission on a disposable
   test account (never a production account).
2. Set repository secrets:
   - `CF_API_TOKEN` — the token
   - `CF_ACCOUNT_ID` — the target account id
   - optionally `CF_ACCOUNT_SUBDOMAIN` / `CF_CANARY_URL` if workers.dev naming
     differs
3. The `compatibility-hosted` workflow (weekly + manual dispatch) then runs
   `compat/canary.mjs`, which:
   - deploys `compat/probes` as a disposable Worker named
     `workflows-mbt-canary`,
   - runs the full differential probe catalog over HTTP,
   - diffs normalized traces against a live `workflows.mbt` run,
   - writes `compat-results/differential-hosted.json` (picked up by the
     capability matrix as `hosted_differential` evidence),
   - deletes the deployment on success *and* failure.

Without the secrets the workflow prints the deferral notice and stays green.
Hosted failures are labelled `oracle: hosted` in the result file and must not
be confused with local Wrangler/workerd drift.
