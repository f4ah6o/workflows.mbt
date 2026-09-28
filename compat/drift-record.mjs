// Turns a contract/semantic drift result into a durable, deduplicated,
// actionable record.
//
//   node compat/drift-record.mjs [--oracle latest|hosted]   # write compat-results/drift-<key>.md when drift exists
//   node compat/drift-record.mjs --oracle hosted --publish  # additionally upsert a GitHub issue keyed by the fingerprint
//
// --oracle picks which result set is inspected: `latest` (default) reads
// drift-latest.json + differential-latest.json; `hosted` reads
// drift-hosted.json + differential-hosted.json. The oracle is part of the
// deduplication key and the issue title, so the same probe failing under
// `wrangler dev` and under the hosted runtime produce separate records.
//
// The deduplication key is a deterministic hash of the oracle, the upstream
// version tuple, and the drift fingerprint (contract paths and failing probe
// ids). Repeated failures of the same unresolved drift update the same
// record instead of creating daily duplicates.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
const publish = process.argv.includes("--publish");
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "latest";

function load(name) {
  const path = join(resultsDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const drift = load(`drift-${oracle}.json`);
const differential = load(`differential-${oracle}.json`);
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

const contractDrift = drift && !drift.pass ? drift.drift : null;
const semanticFailures = differential && !differential.pass
  ? Object.keys(differential.differences ?? {}).sort()
  : [];

if (!contractDrift && semanticFailures.length === 0) {
  console.log(`no ${oracle}-oracle drift — no record written`);
  process.exit(0);
}

const versions = drift?.versions ?? differential?.versions ?? null;
const fingerprint = JSON.stringify({
  oracle,
  versions,
  contract: contractDrift
    ? {
        added: [...contractDrift.added].sort(),
        removed: [...contractDrift.removed].sort(),
        changed: [...contractDrift.changed].sort(),
      }
    : null,
  semantic: semanticFailures,
});
const key = "drift-" + fnv1a(fingerprint);

// Where this record was produced — a CI run link when available so the issue
// lands with a pointer to the full artifacts.
const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const reproduce = oracle === "hosted"
  ? [
      "Hosted run only — needs CF_API_TOKEN + CF_ACCOUNT_ID (see docs/hosted-canary.md):",
      "",
      "    node compat/canary.mjs",
    ]
  : [
      "    npm run compat:typecheck",
      "    node compat/oracle/check.mjs --mode " + oracle,
      "    node compat/run-differential.mjs --oracle " + oracle,
    ];

const lines = [
  "# Compatibility drift record " + key,
  "",
  "Oracle: " + oracle,
  "Upstream tuple: " + JSON.stringify(versions),
  "Compatibility date: " + manifest.compatibilityDate,
  "Detected: " + new Date().toISOString(),
  ...(runUrl ? ["Run: " + runUrl] : []),
  "Dedup key: " + key,
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
  "## Reproduce",
  "",
  ...reproduce,
  "",
  "Normalized expected/actual traces are in compat-results/differential-" + oracle + ".json",
  "under `differences` for each failing probe.",
];
const record = lines.join("\n") + "\n";

mkdirSync(resultsDir, { recursive: true });
const recordPath = join(resultsDir, key + ".md");
writeFileSync(recordPath, record);
console.log("wrote " + recordPath);

if (!publish) process.exit(0);

// Upsert one GitHub issue per drift fingerprint. Same key => comment on the
// existing open issue instead of opening a duplicate.
const repo = process.env.GITHUB_REPOSITORY;
const hasGh = spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
if (!repo || !hasGh || (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)) {
  console.log("publish skipped: gh CLI, GITHUB_REPOSITORY, or token unavailable");
  process.exit(0);
}
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
try {
  gh(["label", "create", "compat-drift", "--repo", repo, "--force"]);
} catch {
  // Label may already exist or permissions may not cover labels; the issue
  // body carries the dedup key either way.
}
const found = gh([
  "issue", "list",
  "--repo", repo,
  "--label", "compat-drift",
  "--state", "open",
  "--search", key,
  "--json", "number",
]);
const issues = JSON.parse(found);
const title = `Compatibility drift (${oracle}): ` + key + " (" + (versions?.wrangler ?? "unknown wrangler") + ")";
if (issues.length === 0) {
  const out = gh(["issue", "create", "--repo", repo, "--label", "compat-drift", "--title", title, "--body", record]);
  console.log("created issue: " + out.trim());
} else {
  gh(["issue", "comment", String(issues[0].number), "--repo", repo, "--body", record]);
  console.log("updated issue #" + issues[0].number);
}
