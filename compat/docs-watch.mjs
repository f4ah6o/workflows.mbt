// Watches the small set of official Cloudflare documentation pages that
// compat/cloudflare/VERSION.md cites as the contract source. A changed page
// is an investigation trigger recorded in the verdict — never a
// compatibility judgement by itself.
//
//   node compat/docs-watch.mjs                   # compare fetched pages to baseline
//   node compat/docs-watch.mjs --update-baseline  # refresh compat/docs-watch.baseline.json
//
// Options:
//   --source-file <path>  doc list source (default compat/cloudflare/VERSION.md)
//   --baseline <path>     baseline file (default compat/docs-watch.baseline.json)
//   --fixture-dir <dir>   read fixture HTML instead of fetching (hermetic
//                         testing): <dir>/<fixture slug>.html per URL
//
// Each page is reduced to its normalized main-content sections before
// hashing: whole-page hashes fire on volatile chrome (A/B markup, timestamps,
// footer widgets), so the unit of comparison is the body of each h1–h3
// section of the main content region, with script/style/svg/footer/time
// elements stripped and whitespace/entities normalized. A changed page
// reports exactly which sections changed.
//
// Writes compat-results/docs-watch.json {checkedAt, sources[], changed[],
// changedSections[], added[], removed[], unfetchable[], baselineCheckedAt}.
// Baseline refresh is deliberate and manual; the watch never hides a change
// by silently re-baselining.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// --- content-section extraction ------------------------------------------
// Pure HTML -> normalized section map; no network. Volatile chrome (scripts,
// styles, svgs, comments, <time>, <footer>) is removed before text is taken,
// and only the main content region is considered so navigation and site
// chrome never contribute to a hash.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function stripVolatile(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|footer|time)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(script|style|noscript|svg|template|footer|time)\b[^>]*>/gi, " ");
}

function htmlToText(fragment) {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const REGION_RE = [
  { name: "main", re: /<main\b[\s\S]*<\/main\s*>/i },
  { name: "article", re: /<article\b[\s\S]*<\/article\s*>/i },
  { name: "body", re: /<body\b[\s\S]*<\/body\s*>/i },
];
const HEADING_RE = /<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]\s*>/gi;
const INTRO_SECTION = "__intro__";

// Returns { scope, sections } where scope is which region was found
// ("main" / "article" / "body" / "document") and sections maps a stable
// section id (slug of its heading text, or __intro__ for the preamble) to
// the sha256 of its normalized text.
export function extractDocSections(html) {
  let scope = "document";
  let region = html;
  for (const candidate of REGION_RE) {
    const match = html.match(candidate.re);
    if (match) {
      scope = candidate.name;
      region = match[0];
      break;
    }
  }
  const clean = stripVolatile(region);
  const headings = [...clean.matchAll(HEADING_RE)];
  const seen = new Map();
  const sectionId = (title) => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";
    const count = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, count);
    return count === 1 ? slug : slug + "#" + count;
  };
  const sections = {};
  for (let i = 0; i <= headings.length; i++) {
    const heading = headings[i - 1];
    const start = heading ? heading.index + heading[0].length : 0;
    const end = i < headings.length ? headings[i].index : clean.length;
    const body = htmlToText(clean.slice(start, end));
    if (!body && !heading) continue;
    const id = heading ? sectionId(htmlToText(heading[0])) : INTRO_SECTION;
    if (body || heading) {
      sections[id] = sha256((heading ? htmlToText(heading[0]) + "\n" : "") + body);
    }
  }
  return { scope, sections };
}

export function fixtureNameFor(url) {
  const parsed = new URL(url);
  return (parsed.hostname + parsed.pathname)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") + ".html";
}

// --- watch ----------------------------------------------------------------

const arg = (name) => {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const updateBaseline = process.argv.includes("--update-baseline");
const sourceFile = arg("source-file") ?? join(root, "compat/cloudflare/VERSION.md");
const baselinePath = arg("baseline") ?? join(root, "compat/docs-watch.baseline.json");
const fixtureDir = arg("fixture-dir");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });
const outPath = join(resultsDir, "docs-watch.json");

const urls = [...readFileSync(sourceFile, "utf8").matchAll(/https:\/\/[^\s)]+/g)]
  .map((m) => m[0]);

async function loadSource(url) {
  const started = Date.now();
  if (fixtureDir) {
    const path = join(fixtureDir, fixtureNameFor(url));
    if (!existsSync(path)) return { status: "unfetchable", error: "fixture missing: " + path };
    return { status: "ok", html: readFileSync(path, "utf8"), ms: Date.now() - started };
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { "user-agent": "workflows.mbt docs-watch" },
  });
  if (!response.ok) return { status: "http-" + response.status };
  return { status: "ok", html: await response.text(), ms: Date.now() - started };
}

const sources = [];
for (const url of urls) {
  try {
    const loaded = await loadSource(url);
    if (loaded.status !== "ok") {
      sources.push({ url, status: loaded.status, error: loaded.error });
      continue;
    }
    const { scope, sections } = extractDocSections(loaded.html);
    sources.push({
      url,
      status: "ok",
      scope,
      sections,
      ms: loaded.ms,
    });
  } catch (error) {
    sources.push({ url, status: "unfetchable", error: String(error?.message ?? error) });
  }
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;
const baselineSources = new Map((baseline?.sources ?? []).map((s) => [s.url, s]));

const changed = [];
const changedSections = [];
for (const source of sources) {
  if (source.status !== "ok") continue;
  const prev = baselineSources.get(source.url);
  if (!prev?.sections) continue;
  const diffs = [];
  for (const [id, hash] of Object.entries(source.sections)) {
    if (!(id in prev.sections)) {
      diffs.push({ section: id, kind: "added" });
    } else if (prev.sections[id] !== hash) {
      diffs.push({ section: id, kind: "changed" });
    }
  }
  for (const id of Object.keys(prev.sections)) {
    if (!(id in source.sections)) diffs.push({ section: id, kind: "removed" });
  }
  if (diffs.length > 0) {
    source.changedSections = diffs;
    changed.push(source.url);
    for (const diff of diffs) changedSections.push({ url: source.url, ...diff });
  }
}
const added = sources
  .filter((s) => s.status === "ok" && baseline && !baselineSources.has(s.url))
  .map((s) => s.url);
const removed = baseline
  ? [...baselineSources.keys()].filter((url) => !sources.some((s) => s.url === url))
  : [];
const unfetchable = sources.filter((s) => s.status !== "ok").map((s) => s.url);

const record = {
  checkedAt: new Date().toISOString(),
  sourceFile: sourceFile.startsWith(root) ? sourceFile.slice(root.length + 1) : sourceFile,
  baselineCheckedAt: baseline?.checkedAt ?? null,
  baselinePresent: Boolean(baseline),
  sources: sources.map((s) => ({
    url: s.url,
    status: s.status,
    scope: s.scope,
    sectionCount: s.sections ? Object.keys(s.sections).length : undefined,
    sections: s.sections,
    changedSections: s.changedSections,
    error: s.error,
    ms: s.ms,
  })),
  changed,
  changedSections,
  added,
  removed,
  unfetchable,
  investigationRequired: changed.length + added.length + removed.length > 0,
};
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");

if (updateBaseline) {
  writeFileSync(baselinePath, JSON.stringify({
    formatVersion: 2,
    checkedAt: record.checkedAt,
    sourceFile: record.sourceFile,
    sources: sources.filter((s) => s.status === "ok")
      .map(({ url, scope, sections }) => ({ url, scope, sections })),
  }, null, 2) + "\n");
  console.log("baseline refreshed at " + baselinePath);
}

console.log(JSON.stringify({
  watched: sources.length,
  changed: changed.length,
  changedSections: changedSections.length,
  added: added.length,
  removed: removed.length,
  unfetchable: unfetchable.length,
  investigationRequired: record.investigationRequired,
}, null, 2));
