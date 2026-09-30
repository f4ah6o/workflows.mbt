// Upstream-item-level feature coverage: the inventory items are the
// denominator, requirements are the existing linkage, oracle states are
// derived from requirement states — never a parallel mapping.
//
//   node compat/upstream-coverage.mjs
//       validate the chain (check-capabilities), compute per-item coverage,
//       write compat-results/upstream-coverage.{json,md} + a stdout summary
//   node compat/upstream-coverage.mjs --oracle pinned
//       restrict the report to one oracle
//   node compat/upstream-coverage.mjs --json-only
//       skip the markdown report (JSON + stdout only)
//   node compat/upstream-coverage.mjs --min-mapped 80 --min-verified 40
//       exit non-zero when mapped/verified coverage is below the threshold
//       (verified is evaluated per reported oracle; for future CI wiring)
//
// Denominator (issue 20260929): upstream inventory items classified
// `target: in-scope` under an active profile. Excluded and deferred-profile
// items are reported separately and never counted.
//
// Per-item state per oracle: the item's referencing requirements' states
// reduced with the same first-match rule as coverage.mjs. UNSUPPORTED
// requirements are declared intent — they never drag a mixed item down;
// an item whose requirements are all UNSUPPORTED is UNSUPPORTED. An item
// with no requirement reference is UNMAPPED (oracle-independent).
//
// Validator failure → status INVALID and a non-zero exit: a normal report
// on unvalidated data is never emitted.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";
import {
  ORACLES,
  activeProfiles,
  currentFreshnessInputs,
  fingerprintIsStale,
  loadDiscoverySpec,
  probeVerdictFor,
  reduceProbeVerdicts,
} from "./coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
const inventoryDir = process.env.WORKFLOWS_MBT_INVENTORY_DIR
  ? resolve(process.env.WORKFLOWS_MBT_INVENTORY_DIR)
  : join(root, "compat/inventory");

const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const jsonOnly = process.argv.includes("--json-only");

const oracleArg = arg("oracle");
const oracleFilter = oracleArg === null ? null : oracleArg;
if (oracleFilter !== null && !ORACLES.includes(oracleFilter)) {
  console.error("--oracle must be one of " + ORACLES.join("|") + ", got " + JSON.stringify(oracleArg));
  process.exit(2);
}
const reportedOracles = oracleFilter ? [oracleFilter] : ORACLES;

const pctFlag = (name) => {
  const value = arg(name);
  if (value === null) return null;
  const pct = Number(value);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    console.error("--" + name + " must be a number between 0 and 100, got " + JSON.stringify(value));
    process.exit(2);
  }
  return pct;
};
const minMapped = pctFlag("min-mapped");
const minVerified = pctFlag("min-verified");

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function loadJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
const loadResult = (name) => loadJson(join(resultsDir, name));

const pct = (num, den) => (den === 0 ? null : Math.round((num / den) * 1000) / 10);

// ── Validator gate ─────────────────────────────────────────────────────────
// Same gate as coverage.mjs: upstream-item coverage is computed only on a
// validated capabilities ↔ requirements ↔ probes ↔ inventory chain.

const validator = spawnSync(process.execPath, [join(root, "compat/check-capabilities.mjs")], {
  stdio: "inherit",
});

mkdirSync(resultsDir, { recursive: true });
// Every run either writes a fresh Markdown report or none at all — drop any
// stale one left by a previous run in a reused results directory.
rmSync(join(resultsDir, "upstream-coverage.md"), { force: true });
if (validator.status !== 0) {
  const invalid = {
    formatVersion: 1,
    status: "INVALID",
    generatedAt: new Date().toISOString(),
    commit: gitCommit(),
    reason: "check-capabilities.mjs failed (status " + validator.status + ") — upstream coverage on unvalidated data is not emitted",
  };
  writeFileSync(join(resultsDir, "upstream-coverage.json"), JSON.stringify(invalid, null, 2) + "\n");
  console.error("upstream coverage status: INVALID — validator failed, no report emitted");
  process.exit(validator.status ?? 1);
}

const spec = loadDiscoverySpec(inventoryDir);
const active = new Set(activeProfiles(spec));
const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const matrix = JSON.parse(readFileSync(
  process.env.WORKFLOWS_MBT_CAPABILITIES
    ? resolve(process.env.WORKFLOWS_MBT_CAPABILITIES)
    : join(root, "compat/capabilities.json"),
  "utf8",
));
const classification = JSON.parse(readFileSync(join(inventoryDir, "classification.json"), "utf8"));
const baselines = {
  api: loadJson(join(inventoryDir, "upstream-api.json")),
  config: loadJson(join(inventoryDir, "upstream-config.json")),
  semantic: loadJson(join(inventoryDir, "semantic.json")),
};

// ── Items and linkage ──────────────────────────────────────────────────────

const items = [...(baselines.api?.items ?? []), ...(baselines.config?.items ?? []), ...(baselines.semantic?.items ?? [])]
  .map((item) => {
    const cls = classification.items?.[item.id] ?? {};
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      container: item.container ?? item.source,
      name: item.name ?? null,
      profile: cls.profile ?? null,
      target: cls.target ?? null,
      lifecycle: spec.profiles[cls.profile]?.lifecycle ?? null,
    };
  })
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// item → requirements / capabilities: the linkage already committed in
// capabilities.json (requirement.upstreamRefs, capability.upstream and
// capability.requirements). Nothing parallel is invented here.
const requirementsById = new Map((matrix.requirements ?? []).map((req) => [req.id, req]));
const itemRequirements = new Map();
for (const req of matrix.requirements ?? []) {
  for (const ref of req.upstreamRefs ?? []) {
    if (!itemRequirements.has(ref)) itemRequirements.set(ref, []);
    itemRequirements.get(ref).push(req.id);
  }
}
const itemCapabilities = new Map();
for (const row of matrix.capabilities ?? []) {
  const direct = new Set([...(row.upstream?.symbols ?? []), ...(row.upstream?.semantic ?? [])]);
  const viaRequirement = (row.requirements ?? []).flatMap((reqId) =>
    (requirementsById.get(reqId)?.upstreamRefs ?? []));
  for (const ref of new Set([...direct, ...viaRequirement])) {
    if (!itemCapabilities.has(ref)) itemCapabilities.set(ref, []);
    itemCapabilities.get(ref).push(row.id);
  }
}

// Scope buckets: in-scope under an active profile is the denominator;
// excluded and deferred-profile items are reported, never counted.
const inScope = items.filter((item) => item.target === "in-scope" && item.lifecycle === "active");
const excluded = items.filter((item) => item.target === "excluded");
const deferred = items.filter((item) => item.target === "in-scope" && item.lifecycle !== "active");

// ── Per-oracle requirement states (same derivation as coverage.mjs) ────────

const oracleRuns = {};
for (const oracle of ORACLES) {
  const result = loadResult("differential-" + oracle + ".json");
  if (!result) {
    oracleRuns[oracle] = { measured: false, reqStates: {} };
    continue;
  }
  const inputs = currentFreshnessInputs(root, resultsDir, oracle, { inventoryDir });
  const stale = fingerprintIsStale(result.fingerprint, inputs);
  const verdicts = {};
  for (const probe of catalog.probes) {
    verdicts[probe.id] = probeVerdictFor(result, probe.id, { stale });
  }
  const reqStates = {};
  for (const req of matrix.requirements ?? []) {
    const perProbe = (req.requiredProbes ?? []).map((probeId) => verdicts[probeId] ?? "UNTESTED");
    reqStates[req.id] = reduceProbeVerdicts(perProbe, { declaredUnsupported: !!req.unsupported });
  }
  oracleRuns[oracle] = {
    measured: true,
    fresh: !stale,
    runId: result.runId ?? null,
    checkedAt: result.checkedAt ?? null,
    reqStates,
  };
}

// Item state in one oracle = reduction over its referencing requirements'
// states. UNSUPPORTED requirements are declared intent: an item reduces to
// UNSUPPORTED only when every referencing requirement is unsupported;
// otherwise they are dropped and the remaining states reduce as usual.
function itemState(itemId, reqStates) {
  const reqs = itemRequirements.get(itemId) ?? [];
  if (reqs.length === 0) return "UNMAPPED";
  const states = reqs.map((reqId) => reqStates[reqId] ?? "UNTESTED");
  const testable = states.filter((state) => state !== "UNSUPPORTED");
  if (testable.length === 0) return "UNSUPPORTED";
  return reduceRequirementItemStates(testable);
}

function reduceRequirementItemStates(states) {
  for (const state of ["DIVERGENT", "BLOCKED", "STALE", "UNTESTED"]) {
    if (states.includes(state)) return state;
  }
  if (states.every((state) => state === "VERIFIED")) return "VERIFIED";
  return "UNTESTED";
}

const ITEM_STATES = ["VERIFIED", "DIVERGENT", "UNSUPPORTED", "UNTESTED", "BLOCKED", "STALE", "UNMAPPED"];

const itemRecords = inScope.map((item) => {
  const reqs = (itemRequirements.get(item.id) ?? []).slice().sort();
  const caps = (itemCapabilities.get(item.id) ?? []).slice().sort();
  const states = {};
  for (const oracle of reportedOracles) {
    states[oracle] = oracleRuns[oracle].measured
      ? itemState(item.id, oracleRuns[oracle].reqStates)
      : (reqs.length === 0 ? "UNMAPPED" : "UNTESTED");
  }
  return { ...item, requirements: reqs, capabilities: caps, states };
});

// ── Aggregation ────────────────────────────────────────────────────────────
// mapped = has at least one requirement reference (oracle-independent);
// verified = item state VERIFIED in that oracle. Oracles are never merged.

function cellFor(group) {
  const mapped = group.filter((item) => item.requirements.length > 0);
  const cell = { items: group.length, mapped: mapped.length, mappedPct: pct(mapped.length, group.length), oracles: {} };
  for (const oracle of reportedOracles) {
    const run = oracleRuns[oracle];
    const states = Object.fromEntries(ITEM_STATES.map((state) => [state, 0]));
    for (const item of group) states[item.states[oracle]] += 1;
    cell.oracles[oracle] = {
      measured: run.measured,
      ...(run.measured ? { fresh: run.fresh } : {}),
      verified: states.VERIFIED,
      verifiedPct: pct(states.VERIFIED, group.length),
      states,
    };
  }
  return cell;
}

function aggregateBy(key) {
  const groups = new Map();
  for (const item of itemRecords) {
    const value = item[key] ?? "(unknown)";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return Object.fromEntries(
    [...groups.keys()].sort().map((value) => [value, cellFor(groups.get(value))]),
  );
}

const overall = cellFor(itemRecords);

// ── Thresholds (for future CI wiring) ──────────────────────────────────────

const problems = [];
if (minMapped !== null && (overall.mappedPct ?? 0) < minMapped) {
  problems.push("mapped " + (overall.mappedPct ?? 0) + "% < --min-mapped " + minMapped + "%");
}
if (minVerified !== null) {
  for (const oracle of reportedOracles) {
    const cell = overall.oracles[oracle];
    // An unmeasured oracle counts as 0% — so a zero floor still passes it.
    const value = cell.measured ? (cell.verifiedPct ?? 0) : 0;
    if (value < minVerified) {
      problems.push(oracle + ": verified " + value + "% < --min-verified " + minVerified + "%"
        + (cell.measured ? "" : " (no measured run, counted as 0%)"));
    }
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────

const report = {
  formatVersion: 1,
  status: problems.length === 0 ? "ok" : "below-threshold",
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  scope: {
    inScope: inScope.length,
    excluded: excluded.length,
    deferred: deferred.length,
    discovered: items.length,
  },
  overall,
  byProfile: aggregateBy("profile"),
  bySource: aggregateBy("source"),
  byKind: aggregateBy("kind"),
  byContainer: aggregateBy("container"),
  items: itemRecords,
};

writeFileSync(join(resultsDir, "upstream-coverage.json"), JSON.stringify(report, null, 2) + "\n");

if (!jsonOnly) {
  const lines = [];
  lines.push("# Upstream feature coverage");
  lines.push("");
  lines.push("Generated by `compat/upstream-coverage.mjs` — denominator = in-scope upstream");
  lines.push("inventory items under active profiles. " + inScope.length + " in-scope, "
    + excluded.length + " excluded, " + deferred.length + " deferred (reported, not counted).");
  lines.push("");
  const header = ["scope", "items", "mapped", "mapped %"];
  for (const oracle of reportedOracles) header.push("verified@" + oracle, "verified %");
  const rowFor = (label, cell) => [
    label,
    String(cell.items),
    String(cell.mapped),
    cell.mappedPct === null ? "—" : cell.mappedPct.toFixed(1),
    ...reportedOracles.flatMap((oracle) => {
      const o = cell.oracles[oracle];
      return [o.measured ? String(o.verified) : "—", o.measured ? o.verifiedPct.toFixed(1) : "—"];
    }),
  ];
  const rows = [["overall", overall],
    ...Object.entries(report.byProfile).map(([k, v]) => ["profile: " + k, v]),
    ...Object.entries(report.bySource).map(([k, v]) => ["source: " + k, v]),
    ...Object.entries(report.byKind).map(([k, v]) => ["kind: " + k, v]),
  ].map(([label, cell]) => rowFor(label, cell));
  lines.push("| " + header.join(" | ") + " |");
  lines.push("| " + header.map(() => "---").join(" | ") + " |");
  for (const row of rows) lines.push("| " + row.join(" | ") + " |");
  lines.push("");
  lines.push("## Unmapped in-scope items (no requirement reference)");
  lines.push("");
  const unmapped = itemRecords.filter((item) => item.requirements.length === 0);
  const byContainer = new Map();
  for (const item of unmapped) {
    if (!byContainer.has(item.container)) byContainer.set(item.container, []);
    byContainer.get(item.container).push(item.id);
  }
  const containers = [...byContainer.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [container, ids] of containers) {
    lines.push("### " + container + " (" + ids.length + ")");
    lines.push("");
    const shown = ids.slice(0, 15);
    for (const id of shown) lines.push("- " + id);
    if (ids.length > shown.length) lines.push("- … " + (ids.length - shown.length) + " more");
    lines.push("");
  }
  writeFileSync(join(resultsDir, "upstream-coverage.md"), lines.join("\n") + "\n");
}

// stdout summary
const oracleBits = reportedOracles.map((oracle) => {
  const o = overall.oracles[oracle];
  return oracle + ": " + (o.measured ? o.verified + "/" + overall.items + " verified (" + o.verifiedPct.toFixed(1) + "%)" : "not measured");
});
console.log("upstream coverage: " + overall.mapped + "/" + overall.items
  + " in-scope items mapped to requirements (" + (overall.mappedPct ?? 0).toFixed(1) + "%)"
  + "; " + oracleBits.join("; ")
  + "; excluded " + excluded.length + ", deferred " + deferred.length);

for (const problem of problems) console.error("- " + problem);
process.exit(problems.length === 0 ? 0 : 1);
