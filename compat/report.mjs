import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "compat-results");
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

function load(name) {
  const path = join(out, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const differentialPinned = load("differential-pinned.json");
const differentialLatest = load("differential-latest.json");
const driftPinned = load("drift-pinned.json");
const driftLatest = load("drift-latest.json");
const latestDrift = driftLatest ?? driftPinned;
const compatibility = readFileSync(join(root, "COMPATIBILITY.md"), "utf8");
const known = compatibility.split("## Known differences")[1]?.split("## Compatibility claim")[0]?.trim() ?? "See COMPATIBILITY.md";

function differentialSummary(result) {
  if (!result) return "not run";
  return result.pass ? "PASS" : "FAIL";
}

function probeLines(label, result) {
  if (!result) return ["- " + label + ": not run"];
  return [
    "- " + label + ": " + differentialSummary(result),
    ...result.probes.map((probe) => "  - " + probe + ": " + (result.differences[probe] ? "FAIL" : "PASS")),
  ];
}

const lines = [
  "# Compatibility verification report",
  "",
  "Generated: " + new Date().toISOString(),
  "",
  "- Oracle date: " + manifest.verifiedAt,
  "- Compatibility date: " + manifest.compatibilityDate,
  "- Pinned Wrangler: " + manifest.wrangler,
  "- Pinned @cloudflare/workers-types: " + manifest.workersTypes,
  "- Pinned workerd: " + manifest.workerd,
  "- Pinned contract: " + (driftPinned ? (driftPinned.pass ? "PASS" : "DRIFT") : "not run"),
  "- Latest contract drift: " + (driftLatest ? (driftLatest.pass ? "none" : "detected") : "not run"),
  "- Pinned differential: " + differentialSummary(differentialPinned),
  "- Latest differential: " + differentialSummary(differentialLatest),
  "",
  "## Differential probes",
  "",
  ...probeLines("pinned", differentialPinned),
  ...probeLines("latest", differentialLatest),
  "",
  "## Contract drift",
  "",
  ...(latestDrift ? [
    "- checked versions: " + JSON.stringify(latestDrift.versions),
    "- added: " + (latestDrift.drift.added.length ? latestDrift.drift.added.join(", ") : "none"),
    "- removed: " + (latestDrift.drift.removed.length ? latestDrift.drift.removed.join(", ") : "none"),
    "- changed: " + (latestDrift.drift.changed.length ? latestDrift.drift.changed.join(", ") : "none"),
  ] : ["- not run"]),
  "",
  "## Known differences",
  "",
  known,
  "",
];
const report = lines.join("\n");
writeFileSync(join(out, "report.md"), report);
console.log(report);
