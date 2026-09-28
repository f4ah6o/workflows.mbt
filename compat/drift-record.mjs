// Turns a contract/semantic drift verdict into a durable, deduplicated,
// actionable response packet.
//
//   node compat/drift-record.mjs [--oracle latest|hosted]
//   node compat/drift-record.mjs --oracle latest --publish      # also try GitHub issues
//   node compat/drift-record.mjs --oracle latest --publish --dry-run
//   node compat/drift-record.mjs --oracle latest --publish --mock-dir compat-results/mock-publish
//
// Problem identity vs observation identity: the dedup key hashes the oracle
// and the drift fingerprint (contract paths + failing probe ids) only —
// NOT the upstream version tuple. The same root cause re-observed under a
// new wrangler/miniflare/workerd release updates the same record and appends
// the new tuple to `versionsSeen`; it never spawns a second record.
//
// Destinations:
//   - file (always): compat-results/drift-<key>.md — uploaded as a CI
//     artifact. Artifact retention is limited (see the workflow's
//     actions/upload-artifact retention-days).
//   - issues/open/<date>-<key>.md (always): the repo's durable,
//     commit-able issue convention — the same packet upserted in place so
//     a human can commit it. Override the directory with --issues-dir or
//     WORKFLOWS_MBT_ISSUES_DIR (tests use it to stay hermetic).
//   - github-issue (only behind --publish): checked at run start via
//     `gh api repos/{repo} --jq .has_issues`. When Issues is disabled, gh is
//     missing, the token is unset, or the API errors, the publisher records
//     the skipped/failed outcome in compat-results/publish-<key>.json and
//     never claims notification success.
//   - --mock-dir writes the exact payloads the GitHub path would send to
//     files instead, so the publisher is testable without an API token.
//
// Notification policy: one issue per problem identity. A comment is posted
// only when the observation materially changes (new version tuple, or a
// status transition open -> resolved -> recurred). Repeated identical
// observations never re-comment.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
const publish = process.argv.includes("--publish");
const dryRun = process.argv.includes("--dry-run");
const mockIndex = process.argv.indexOf("--mock-dir");
const mockDir = mockIndex >= 0 ? resolve(process.argv[mockIndex + 1]) : null;
const issuesIndex = process.argv.indexOf("--issues-dir");
const issuesDir = issuesIndex >= 0
  ? resolve(process.argv[issuesIndex + 1])
  : resolve(process.env.WORKFLOWS_MBT_ISSUES_DIR ?? join(root, "issues/open"));
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "latest";

function load(name) {
  const path = join(resultsDir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const verdict = load(`verdict-${oracle}.json`);
const drift = load(`drift-${oracle}.json`);
const differential = load(`differential-${oracle}.json`);
const typecheck = load(`typecheck-${oracle}.json`);
const candidate = load(`candidate-${oracle}.json`);
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));
const capabilities = load("capabilities.json") ?? JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));

const contractDrift = drift && !drift.pass ? drift.drift : null;
const diffProbes = new Set(Object.keys(differential?.differences ?? {}));
const errorProbes = new Set(Object.keys(differential?.probeErrors ?? {}));
const semanticFailures = differential && !differential.pass
  ? [...new Set([...diffProbes, ...errorProbes])].sort()
      .map((p) => (errorProbes.has(p) ? `${p} (execution error)` : p))
  : [];
const sideErrors = Object.entries(differential?.sideErrors ?? {})
  .filter(([, value]) => value)
  .map(([side, value]) => `${side}: ${value}`);

const now = new Date().toISOString();
const versions = candidate?.versions ?? drift?.versions ?? differential?.versions ?? null;
const versionsTuple = versions
  ? `${versions.wrangler}/${versions.workersTypes ?? versions["@cloudflare/workers-types"]}/${versions.workerd}`
  : "unknown";
const runId = differential?.runId ?? drift?.runId ?? typecheck?.runId ?? verdict?.runId ?? null;
const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

// ---- state sidecar -------------------------------------------------------
const statePath = join(resultsDir, "drift-state.json");
const state = (() => {
  if (!existsSync(statePath)) return { keys: {} };
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return { keys: {} }; }
})();
state.keys ??= {};

const hasDrift = Boolean(contractDrift) || semanticFailures.length > 0;

function identityFor() {
  // Problem identity: oracle + what is wrong, never which version showed it.
  return "drift-" + fnv1a(JSON.stringify({
    oracle,
    contract: contractDrift
      ? {
          added: [...contractDrift.added].sort(),
          removed: [...contractDrift.removed].sort(),
          changed: [...contractDrift.changed].sort(),
        }
      : null,
    semantic: semanticFailures.map((p) => p.replace(/ \(execution error\)$/, "")).sort(),
  }));
}

// ---- durable state: sidecar cache over committed issue packets ----------
// compat-results/ is ephemeral (a fresh CI checkout has none). The durable
// truth is issues/open/<date>-<key>.md — each packet carries a machine
// footer `<!-- drift-state:{...} -->` with the entry minus publish fields.
// On every run we rebuild keys from those committed packets and merge any
// the sidecar lost, so versionsSeen/resolve/recur survive across runs.
const FOOTER_PREFIX = "<!-- drift-state:";
function issueFileFor(problemKey) {
  let files = [];
  try { files = readdirSync(issuesDir); } catch {}
  return files.find((f) => f.endsWith(`-${problemKey}.md`) || f === `${problemKey}.md`) ?? null;
}
function rebuildStateFromIssues() {
  const rebuilt = {};
  let files = [];
  try { files = readdirSync(issuesDir); } catch {}
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const m = f.match(/(drift-[0-9a-f]{8})\.md$/);
    if (!m) continue;
    try {
      const text = readFileSync(join(issuesDir, f), "utf8");
      const idx = text.lastIndexOf(FOOTER_PREFIX);
      if (idx < 0) continue;
      const end = text.indexOf("-->", idx);
      if (end < 0) continue;
      rebuilt[m[1]] = JSON.parse(text.slice(idx + FOOTER_PREFIX.length, end).trim());
    } catch {}
  }
  return rebuilt;
}
function stateFooterFor(stateEntry) {
  // Persist the issue number (needed to find the issue again) but never
  // lastCommentHash — a hash of the record cannot live inside the hashed
  // record. Comment dedup instead derives from the issue's comment history.
  const rest = { ...stateEntry };
  if (rest.github?.issue) rest.github = { issue: rest.github.issue };
  else delete rest.github;
  return `\n${FOOTER_PREFIX}${JSON.stringify(rest)} -->\n`;
}
function stripFooter(text) {
  const idx = text.lastIndexOf(FOOTER_PREFIX);
  if (idx < 0) return text.endsWith("\n") ? text : text + "\n";
  return text.slice(0, idx).replace(/\n+$/, "\n");
}
for (const [k, rebuilt] of Object.entries(rebuildStateFromIssues())) {
  state.keys[k] ??= rebuilt;
}

const resolutions = [];
if (!hasDrift) {
  // Resolve open keys only on complete positive evidence: an explicit
  // compatible verdict, or (pre-verdict evidence) both contract and
  // differential phases passing. Missing/malformed phases are incomplete
  // evidence — they never resolve a record. Both open and recurred resolve:
  // a recurrence fixed upstream is resolved evidence, not a permanent flag.
  const positiveEvidence = verdict?.verdict === "compatible"
    || (verdict == null && drift?.pass === true && differential?.pass === true);
  if (!positiveEvidence) {
    console.log(`no ${oracle}-oracle drift, but evidence is incomplete — existing records unchanged`);
    process.exit(0);
  }
  for (const [key, entry] of Object.entries(state.keys)) {
    if (entry.oracle === oracle && (entry.status === "open" || entry.status === "recurred")) {
      entry.status = "resolved";
      entry.resolvedAt = now;
      entry.resolvedUnder = versionsTuple;
      resolutions.push(key);
      // The durable packet must reflect resolution too — a fresh run
      // rebuilds state from these files.
      const issueFile = issueFileFor(key);
      if (issueFile) {
        const text = readFileSync(join(issuesDir, issueFile), "utf8");
        const updated = stripFooter(text).replace(/^Status: .+$/m, "Status: resolved")
          + stateFooterFor(entry);
        writeFileSync(join(issuesDir, issueFile), updated);
      }
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  if (resolutions.length) {
    console.log("resolved drift records: " + resolutions.join(", "));
  } else {
    console.log(`no ${oracle}-oracle drift — no record written`);
  }
  // A resolution is a material transition — when publishing is requested,
  // route it through the same GitHub path (comment + close) instead of
  // exiting silently. resolutionPublishedAt marks terminal outcomes only:
  // failed/skipped/no-destination retries on the next invocation.
  if (!publish) process.exit(0);
  const resolutionOutcomes = {};
  for (const [k, e] of Object.entries(state.keys)) {
    if (e.oracle !== oracle || e.status !== "resolved" || e.resolutionPublishedAt != null) continue;
    const outcome = publishResolution(k, e);
    resolutionOutcomes[k] = outcome;
    if (outcome.status === "resolved-posted" || outcome.status === "closed-already") {
      e.resolutionPublishedAt = now;
    }
    writeFileSync(join(resultsDir, `publish-${k}.json`), JSON.stringify({
      key: k, oracle, at: now, requested: true, dryRun,
      destinations: { github: outcome },
    }, null, 2) + "\n");
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.log("resolution publish: " + (Object.keys(resolutionOutcomes).length
    ? JSON.stringify(resolutionOutcomes) : "nothing pending"));
  process.exit(0);
}

const key = identityFor();
const entry = state.keys[key] ??= {
  oracle,
  status: "open",
  firstSeen: now,
  versionsSeen: [],
  observations: 0,
  recurCount: 0,
};
let transition = null;
if (entry.status === "resolved") {
  entry.status = "recurred";
  entry.recurCount += 1;
  transition = "resolved->recurred";
} else if (entry.status === "recurred") {
  transition = null;
} else {
  transition = entry.observations === 0 ? "new" : null;
}
entry.lastSeen = now;
entry.observations += 1;
const isNewVersion = !entry.versionsSeen.includes(versionsTuple);
if (isNewVersion) entry.versionsSeen.push(versionsTuple);

// ---- response packet -----------------------------------------------------

const capabilityRows = capabilities?.capabilities ?? [];
const affected = semanticFailures.map((p) => {
  const id = p.replace(/ \(execution error\)$/, "");
  const cap = capabilityRows.find((row) => row.probes?.includes(id)) ?? null;
  return { probe: p, capability: cap ? cap.id + " — " + cap.title : null };
});

const reproduce = oracle === "hosted"
  ? ["Hosted run only — needs CF_API_TOKEN + CF_ACCOUNT_ID (see docs/hosted-canary.md):", "", "    node compat/canary.mjs"]
  : ["    npm run compat:latest   # resolves @latest once, then typecheck + contract + differential + verdict"];

const fixCandidates = [];
if (contractDrift?.removed?.length) {
  fixCandidates.push("Contract surface removed members: " + contractDrift.removed.join(", ")
    + " — check compat/oracle/api-surface.json and the compat/typecheck fixture; either restore support or record an intentional non-support rationale.");
}
if (contractDrift?.added?.length) {
  fixCandidates.push("New upstream surface: " + contractDrift.added.join(", ")
    + " — decide support vs documented non-support; do not just snapshot the new surface.");
}
for (const p of semanticFailures) {
  fixCandidates.push("Probe " + p + " — expected/actual normalized traces are under `differences` in compat-results/differential-"
    + oracle + ".json; fix the runtime semantics or mark the probe intentionally unsupported in compat/probes/catalog.json.");
}
if (!fixCandidates.length && sideErrors.length) {
  fixCandidates.push("A side failed to run — fix the harness/runtime first; this is not evidence of drift.");
}

const unconfirmed = [];
if (!typecheck) unconfirmed.push("typecheck phase did not run — contract typing evidence missing");
if (!differential) unconfirmed.push("differential phase did not run — semantic evidence missing");
if (verdict?.docsWatch?.changed?.length) {
  unconfirmed.push("documentation watch changed: " + verdict.docsWatch.changed.join(", "));
}
if (verdict?.docsWatch?.unfetchable?.length) {
  unconfirmed.push("documentation sources unfetchable: " + verdict.docsWatch.unfetchable.join(", "));
}

const lines = [
  "# Compatibility drift record " + key,
  "",
  "Status: " + entry.status,
  "Created: " + entry.firstSeen.slice(0, 10),
  "",
  "Oracle: " + oracle,
  "Status detail: " + entry.status + (entry.recurCount ? " (recurrences: " + entry.recurCount + ")" : ""),
  "Verdict: " + (verdict?.verdict ?? "drift (no verdict file — older evidence format)"),
  "Problem key: " + key,
  "First seen: " + entry.firstSeen,
  "Last seen: " + now,
  "Versions seen: " + entry.versionsSeen.join(", "),
  "Observed tuple now: " + versionsTuple,
  "Baseline tuple (pinned): " + `${manifest.wrangler}/${manifest.workersTypes}/${manifest.workerd}`,
  "Compatibility date: " + (candidate?.conditions?.compatibilityDate ?? manifest.compatibilityDate),
  "Candidate id: " + (candidate?.id ?? "n/a"),
  "Run id: " + (runId ?? "n/a"),
  ...(runUrl ? ["Run: " + runUrl] : []),
  "",
  "## Contract drift",
  "",
  ...(contractDrift
    ? [
        "- added: " + (contractDrift.added.join(", ") || "none"),
        "- removed: " + (contractDrift.removed.join(", ") || "none"),
        "- changed: " + (contractDrift.changed.join(", ") || "none"),
      ]
    : ["- none" + (oracle === "hosted" ? " (hosted oracle does not typecheck the contract)" : "")]),
  "",
  "## Semantic probe failures",
  "",
  ...(semanticFailures.length ? semanticFailures.map((p) => "- " + p) : ["- none"]),
  "",
  "## Affected capabilities",
  "",
  ...(affected.length
    ? affected.map((a) => "- " + a.probe + (a.capability ? " — " + a.capability : ""))
    : ["- none"]),
  "",
  "## Errors",
  "",
  ...(sideErrors.length ? sideErrors.map((e) => "- " + e) : ["- none"]),
  "",
  "## Expected vs actual",
  "",
  "Normalized expected/actual traces are in compat-results/differential-" + oracle + ".json",
  "under `differences` for each failing probe (Cloudflare side = expected, workflows.mbt = actual).",
  "",
  "## Minimal fix candidates",
  "",
  ...fixCandidates.map((c) => "- " + c),
  "",
  "## Unconfirmed",
  "",
  ...(unconfirmed.length ? unconfirmed.map((u) => "- " + u) : ["- none"]),
  "",
  "## Reproduce",
  "",
  ...reproduce,
  "",
  "## Artifact refs",
  "",
  "- compat-results/drift-" + oracle + ".json (contract phase)",
  "- compat-results/differential-" + oracle + ".json (semantic phase)",
  "- compat-results/verdict-" + oracle + ".json (verdict)",
  "- compat-results/candidate-" + oracle + ".json (exact upstream candidate incl. real runtime graph)",
];
const record = lines.join("\n") + stateFooterFor(entry);

mkdirSync(resultsDir, { recursive: true });
const recordPath = join(resultsDir, key + ".md");
writeFileSync(recordPath, record);
console.log("wrote " + recordPath);

// Durable repo-local destination: the issues/open convention. The same
// packet is upserted under a dated name — a human reviews and commits it;
// CI runs just leave it in the checkout. The filename is stable per problem
// identity: an existing packet is updated in place; a new one uses the
// first-seen date, never the re-observation date.
mkdirSync(issuesDir, { recursive: true });
const existingIssueFile = issueFileFor(key);
const issuePath = join(issuesDir,
  existingIssueFile ?? `${entry.firstSeen.slice(0, 10).replaceAll("-", "")}-${key}.md`);
writeFileSync(issuePath, record);
console.log("wrote " + issuePath);

// ---- publish -------------------------------------------------------------
const publishOutcome = {
  key,
  oracle,
  at: now,
  requested: publish,
  dryRun,
  destinations: {
    file: { status: "written", path: recordPath },
    issuesOpen: { status: "written", path: issuePath },
  },
};
if (!publish) {
  publishOutcome.destinations.github = { status: "not-requested" };
} else if (dryRun) {
  publishOutcome.destinations.github = { status: "dry-run", title: issueTitle() };
} else if (mockDir) {
  mkdirSync(mockDir, { recursive: true });
  writeFileSync(join(mockDir, key + ".issue.json"), JSON.stringify({
    action: entry.github?.issue ? "comment" : "create",
    issue: entry.github?.issue ?? null,
    title: issueTitle(),
    labels: ["compat-drift"],
    body: record,
  }, null, 2) + "\n");
  publishOutcome.destinations.github = { status: "mocked", dir: mockDir };
} else {
  publishOutcome.destinations.github = publishToGitHub();
}
// The publish may have learned the issue number — rewrite both packets so
// the durable file's footer carries it forward.
if (entry.github?.issue) {
  const finalRecord = stripFooter(record) + stateFooterFor(entry);
  writeFileSync(recordPath, finalRecord);
  writeFileSync(issuePath, finalRecord);
}
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
writeFileSync(join(resultsDir, `publish-${key}.json`), JSON.stringify(publishOutcome, null, 2) + "\n");
console.log("publish outcome: " + JSON.stringify(publishOutcome.destinations));

function issueTitle() {
  return `Compatibility drift (${oracle}): ` + key;
}

function ghOrNull(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}

function githubPrecheck() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return { status: "skipped", reason: "GITHUB_REPOSITORY unset" };
  if (spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0) {
    return { status: "skipped", reason: "gh CLI unavailable" };
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return { status: "skipped", reason: "no GH_TOKEN/GITHUB_TOKEN" };
  }
  // Availability precheck: Issues may be disabled on the repo — then there is
  // no working destination and the file packet is the whole response path.
  const meta = ghOrNull(["api", `repos/${repo}`, "--jq", ".has_issues"]);
  if (meta == null) return { status: "failed", reason: "gh api repos/<repo> failed (auth/permissions?)" };
  if (meta.trim() !== "true") return { status: "skipped", reason: "GitHub Issues disabled on " + repo };
  return { status: "ok", repo };
}

function resolutionBody(problemKey, stateEntry) {
  return [
    `Resolved under ${versionsTuple}.`,
    `run: ${runId ?? "n/a"}` + (runUrl ? ` (${runUrl})` : ""),
    `resolved at: ${stateEntry.resolvedAt ?? now}`,
    `problem key: ${problemKey}`,
  ].join("\n");
}

// A resolved record's publish: comment on the issue, then close it.
function publishResolution(problemKey, stateEntry) {
  if (dryRun) return { status: "dry-run", issue: stateEntry.github?.issue ?? null };
  if (mockDir) {
    mkdirSync(mockDir, { recursive: true });
    writeFileSync(join(mockDir, problemKey + ".resolution.json"), JSON.stringify({
      action: "resolve",
      issue: stateEntry.github?.issue ?? null,
      close: true,
      body: resolutionBody(problemKey, stateEntry),
    }, null, 2) + "\n");
    return { status: "resolved-posted", issue: stateEntry.github?.issue ?? null, mocked: mockDir };
  }
  const check = githubPrecheck();
  if (check.status !== "ok") return check;
  const repo = check.repo;
  try {
    let issue = stateEntry.github?.issue ?? null;
    if (!issue) {
      const found = ghOrNull([
        "issue", "list", "--repo", repo, "--label", "compat-drift",
        "--state", "all", "--search", problemKey, "--json", "number,state",
      ]);
      if (found == null) return { status: "failed", reason: "gh issue list failed" };
      issue = JSON.parse(found)[0]?.number ?? null;
    }
    if (!issue) return { status: "skipped", reason: "no matching drift issue found" };
    const view = ghOrNull(["issue", "view", String(issue), "--repo", repo, "--json", "state"]);
    if (view == null) return { status: "failed", reason: "gh issue view failed", issue };
    if (JSON.parse(view).state === "CLOSED") {
      stateEntry.github = { ...(stateEntry.github ?? {}), issue };
      return { status: "closed-already", issue };
    }
    const body = resolutionBody(problemKey, stateEntry);
    if (ghOrNull(["issue", "comment", String(issue), "--repo", repo, "--body", body]) == null) {
      return { status: "failed", reason: "gh issue comment failed", issue };
    }
    ghOrNull(["issue", "close", String(issue), "--repo", repo]);
    stateEntry.github = { ...(stateEntry.github ?? {}), issue };
    return { status: "resolved-posted", issue };
  } catch (error) {
    return { status: "failed", reason: String(error?.message ?? error) };
  }
}

function publishToGitHub() {
  const check = githubPrecheck();
  if (check.status !== "ok") return check;
  const repo = check.repo;

  try {
    ghOrNull(["label", "create", "compat-drift", "--repo", repo, "--force"]);
    let existing = entry.github?.issue ? { number: entry.github.issue } : null;
    if (!existing) {
      const found = ghOrNull([
        "issue", "list", "--repo", repo, "--label", "compat-drift",
        "--state", "all", "--search", key, "--json", "number,state",
      ]);
      if (found == null) return { status: "failed", reason: "gh issue list failed" };
      existing = JSON.parse(found)[0] ?? null;
    }
    const title = issueTitle() + " (" + versionsTuple + ")";
    if (!existing) {
      const out = ghOrNull(["issue", "create", "--repo", repo, "--label", "compat-drift",
        "--title", title, "--body", record]);
      if (out == null) return { status: "failed", reason: "gh issue create failed" };
      const num = Number(out.trim().split("/").pop());
      entry.github = { issue: num || null };
      return { status: "created", issue: num || null };
    }
    // No-spam dedup derived from the issue itself: if the latest comment
    // already is this packet (footer stripped — state noise doesn't count),
    // an identical observation posts nothing. Works across runs even when
    // the local state sidecar was lost.
    const bodyKey = stripFooter(record).trim();
    const commentsJson = ghOrNull([
      "api", `repos/${repo}/issues/${existing.number}/comments?per_page=1&direction=desc`,
    ]);
    if (commentsJson == null) return { status: "failed", reason: "gh api comments failed", issue: existing.number };
    let lastBody = null;
    try { lastBody = JSON.parse(commentsJson)[0]?.body ?? null; } catch {}
    const shouldComment = isNewVersion || transition != null
      || stripFooter(lastBody ?? "").trim() !== bodyKey;
    entry.github = { ...(entry.github ?? {}), issue: existing.number };
    if (!shouldComment) {
      return { status: "skipped", reason: "identical observation already recorded", issue: existing.number };
    }
    const out = ghOrNull(["issue", "comment", String(existing.number), "--repo", repo, "--body", record]);
    if (out == null) return { status: "failed", reason: "gh issue comment failed", issue: existing.number };
    return { status: "commented", issue: existing.number };
  } catch (error) {
    return { status: "failed", reason: String(error?.message ?? error) };
  }
}
