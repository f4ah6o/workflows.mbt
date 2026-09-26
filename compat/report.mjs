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

const pinned = load("differential-pinned.json");
const driftPinned = load("drift-pinned.json");
const driftLatest = load("drift-latest.json");
const latest = driftLatest ?? driftPinned;
const compatibility = readFileSync(join(root, "COMPATIBILITY.md"), "utf8");
const known = compatibility.split("## Known differences")[1]?.split("## Compatibility claim")[0]?.trim() ?? "See COMPATIBILITY.md";

const lines = [
  "# Compatibility verification report",
  "",
  "Generated: " + new Date().toISOString(),
  "",
  "- Oracle date: " + manifest.verifiedAt,
  "- Compatibility date: " + manifest.compatibilityDate,
  "- Wrangler: " + manifest.wrangler,
  "- @cloudflare/workers-types: " + manifest.workersTypes,
  "- workerd: " + manifest.workerd,
  "- Pinned contract: " + (driftPinned ? (driftPinned.pass ? "PASS" : "DRIFT") : "not run"),
  "- Latest contract drift: " + (driftLatest ? (driftLatest.pass ? "none" : "detected") : "not run"),
  "- Differential probes: " + (pinned ? (pinned.pass ? "PASS" : "FAIL") : "not run"),
  "",
  "## Differential probes",
  "",
  ...(pinned ? pinned.probes.map((probe) => "- " + probe + ": " + (pinned.differences[probe] ? "FAIL" : "PASS")) : ["- not run"]),
  "",
  "## Contract drift",
  "",
  ...(latest ? [
    "- added: " + (latest.drift.added.length ? latest.drift.added.join(", ") : "none"),
    "- removed: " + (latest.drift.removed.length ? latest.drift.removed.join(", ") : "none"),
    "- changed: " + (latest.drift.changed.length ? latest.drift.changed.join(", ") : "none"),
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
