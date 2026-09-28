// Turns a latest-upstream contract/semantic drift result into a durable,
// deduplicated, actionable record.
//
//   node compat/drift-record.mjs            # write compat-results/drift-<key>.md when drift exists
//   node compat/drift-record.mjs --publish  # additionally upsert a GitHub issue keyed by the drift fingerprint
//
// The deduplication key is a deterministic hash of the upstream version tuple
// plus the drift fingerprint (contract paths and failing probe ids). Repeated
// failures of the same unresolved drift update the same record instead of
// creating daily duplicates.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
const publish = process.argv.includes("--publish");

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

const driftLatest = load("drift-latest.json");
const differentialLatest = load("differential-latest.json");
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

const contractDrift = driftLatest && !driftLatest.pass ? driftLatest.drift : null;
const semanticFailures = differentialLatest && !differentialLatest.pass
  ? Object.keys(differentialLatest.differences ?? {}).sort()
  : [];

if (!contractDrift && semanticFailures.length === 0) {
  console.log("no latest-upstream drift — no record written");
  process.exit(0);
}

const versions = driftLatest?.versions ?? null;
const fingerprint = JSON.stringify({
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

const lines = [
  "# Compatibility drift record " + key,
  "",
  "Upstream tuple: " + JSON.stringify(versions),
  "Compatibility date: " + manifest.compatibilityDate,
  "Detected: " + new Date().toISOString(),
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
    : ["- none"]),
  "",
  "## Semantic probe failures",
  "",
  ...(semanticFailures.length ? semanticFailures.map((p) => "- " + p) : ["- none"]),
  "",
  "## Reproduce",
  "",
  "npm run compat:typecheck",
  "node compat/oracle/check.mjs --mode latest",
  "node compat/run-differential.mjs --oracle latest",
  "",
  "Normalized expected/actual traces are in compat-results/differential-latest.json",
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
const found = gh([
  "issue", "list",
  "--repo", repo,
  "--label", "compat-drift",
  "--state", "open",
  "--search", key,
  "--json", "number",
]);
const issues = JSON.parse(found);
const title = "Compatibility drift: " + key + " (" + (versions?.wrangler ?? "unknown wrangler") + ")";
if (issues.length === 0) {
  const out = gh(["issue", "create", "--repo", repo, "--label", "compat-drift", "--title", title, "--body", record]);
  console.log("created issue: " + out.trim());
} else {
  gh(["issue", "comment", String(issues[0].number), "--repo", repo, "--body", record]);
  console.log("updated issue #" + issues[0].number);
}
