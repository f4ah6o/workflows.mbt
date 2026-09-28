// Watches the small set of official Cloudflare documentation pages that
// compat/cloudflare/VERSION.md cites as the contract source. A changed page
// is an investigation trigger recorded in the verdict — never a
// compatibility judgement by itself.
//
//   node compat/docs-watch.mjs                  # compare fetched hashes to baseline
//   node compat/docs-watch.mjs --update-baseline # refresh compat/docs-watch.baseline.json
//
// Writes compat-results/docs-watch.json {checkedAt, sources[], changed[],
// unfetchable[], baselineCheckedAt}. Baseline refresh is deliberate and
// manual; the watch never hides a change by silently re-baselining.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });
const updateBaseline = process.argv.includes("--update-baseline");
const versionDoc = join(root, "compat/cloudflare/VERSION.md");
const baselinePath = join(root, "compat/docs-watch.baseline.json");
const outPath = join(resultsDir, "docs-watch.json");

const urls = [...readFileSync(versionDoc, "utf8")
  .matchAll(/https:\/\/[^\s)]+/g)]
  .map((m) => m[0]);

const sources = [];
for (const url of urls) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { "user-agent": "workflows.mbt docs-watch" },
    });
    if (!response.ok) {
      sources.push({ url, status: "http-" + response.status });
      continue;
    }
    const text = await response.text();
    sources.push({ url, status: "ok", sha256: createHash("sha256").update(text).digest("hex"), ms: Date.now() - started });
  } catch (error) {
    sources.push({ url, status: "unfetchable", error: String(error?.message ?? error) });
  }
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;
const baselineHashes = new Map((baseline?.sources ?? []).map((s) => [s.url, s.sha256]));

const changed = sources
  .filter((s) => s.status === "ok" && baselineHashes.has(s.url) && baselineHashes.get(s.url) !== s.sha256)
  .map((s) => s.url);
const added = sources
  .filter((s) => s.status === "ok" && baseline && !baselineHashes.has(s.url))
  .map((s) => s.url);
const removed = baseline
  ? [...baselineHashes.keys()].filter((url) => !sources.some((s) => s.url === url))
  : [];
const unfetchable = sources.filter((s) => s.status !== "ok").map((s) => s.url);

const record = {
  checkedAt: new Date().toISOString(),
  sourceFile: "compat/cloudflare/VERSION.md",
  baselineCheckedAt: baseline?.checkedAt ?? null,
  baselinePresent: Boolean(baseline),
  sources,
  changed,
  added,
  removed,
  unfetchable,
  investigationRequired: changed.length + added.length + removed.length > 0,
};
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");

if (updateBaseline) {
  writeFileSync(baselinePath, JSON.stringify({
    checkedAt: record.checkedAt,
    sourceFile: record.sourceFile,
    sources: sources.filter((s) => s.status === "ok").map(({ url, sha256 }) => ({ url, sha256 })),
  }, null, 2) + "\n");
  console.log("baseline refreshed at " + baselinePath);
}

console.log(JSON.stringify({
  watched: sources.length,
  changed: changed.length,
  added: added.length,
  removed: removed.length,
  unfetchable: unfetchable.length,
  investigationRequired: record.investigationRequired,
}, null, 2));
