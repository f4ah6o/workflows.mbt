// Resolved-inventory validator (issue 20260929 §3, §10). Joins the committed
// baselines (compat/inventory/upstream-*.json + semantic.json) with the
// human-owned classification (compat/inventory/classification.json) on stable
// IDs and verifies the contract the rest of the chain relies on.
//
//   node compat/check-inventory.mjs
//       committed-file checks only (hermetic — no upstream needed)
//   node compat/check-inventory.mjs --verify [--mode pinned]
//       additionally re-extracts the candidate inventory from the resolved
//       candidate (or --types/--schema overrides) and diffs it against the
//       committed baseline: upstream additions/removals/changes and baseline
//       entries the current discovery roots can no longer produce are
//       violations.
//   node compat/check-inventory.mjs --report [--mode latest]
//       re-extract the candidate inventory and write compat-results/
//       inventory-<mode>.json (classified items) and inventory-diff-<mode>.json
//       (baseline diff) WITHOUT failing on differences — the daily latest
//       pipeline consumes these to build its investigation packet (§10).
//
// Writes compat-results/resolved-inventory.json and inventory-check.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCandidate, resultsDirFor } from "./candidate.mjs";
import { loadDiscoverySpec } from "./coverage-model.mjs";
import { buildCandidateInventory } from "./inventory/extract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryDir = process.env.WORKFLOWS_MBT_INVENTORY_DIR
  ? resolve(process.env.WORKFLOWS_MBT_INVENTORY_DIR)
  : join(root, "compat/inventory");
const resultsDir = resultsDirFor(root);

const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const verify = process.argv.includes("--verify");
const report = process.argv.includes("--report");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const spec = loadDiscoverySpec(inventoryDir);
const baselines = {
  api: loadJson(join(inventoryDir, "upstream-api.json")),
  config: loadJson(join(inventoryDir, "upstream-config.json")),
  semantic: loadJson(join(inventoryDir, "semantic.json")),
};
const classification = loadJson(join(inventoryDir, "classification.json"));

const errors = [];
const fail = (message) => errors.push(message);

// ── Resolved inventory = baseline ⋈ classification on stable ID ────────────

const baselineItems = [...baselines.api.items, ...baselines.config.items, ...baselines.semantic.items];
const baselineIds = new Set();
for (const item of baselineItems) {
  if (baselineIds.has(item.id)) fail("duplicate inventory id across baselines: " + item.id);
  baselineIds.add(item.id);
}
for (const item of baselineItems) {
  if (!item.contract?.fingerprint && item.source !== "semantic") {
    fail(item.id + ": baseline item missing contract.fingerprint");
  }
}

const classRows = classification.items ?? {};
const classIds = new Set(Object.keys(classRows));

const resolved = [];
const unclassified = [];
for (const item of baselineItems) {
  const row = classRows[item.id];
  if (!row) {
    unclassified.push(item.id);
    resolved.push({ ...item, profile: null, target: null });
    continue;
  }
  if (!spec.profiles[row.profile]) fail(item.id + ": classification profile is not defined: " + JSON.stringify(row.profile));
  if (!["in-scope", "excluded"].includes(row.target)) {
    fail(item.id + ": classification target must be in-scope|excluded, got " + JSON.stringify(row.target));
  }
  if (row.target === "excluded" && !row.exclusionReason) {
    fail(item.id + ": excluded item must carry a machine-readable exclusionReason");
  }
  if (row.target === "in-scope" && row.exclusionReason) {
    fail(item.id + ": in-scope item must not carry exclusionReason");
  }
  if (row.target === "excluded" && row.unsupportedReason) {
    fail(item.id + ": excluded item must not carry unsupportedReason (unsupportedReason is for in-scope items)");
  }
  resolved.push({ ...item, profile: row.profile ?? null, target: row.target ?? null, classification: row });
}

if (unclassified.length) {
  fail("unclassified baseline items (classification coverage < 100%): " + unclassified.slice(0, 10).join(", ") + (unclassified.length > 10 ? " … +" + (unclassified.length - 10) : ""));
}

// Classification rows whose stable ID no longer exists are stale — they
// survive baseline removal on purpose, and the validator reports them.
const staleClassification = [...classIds].filter((id) => !baselineIds.has(id));
if (staleClassification.length) {
  fail("classification rows with no baseline item (stale classification): " + staleClassification.slice(0, 10).join(", ") + (staleClassification.length > 10 ? " … +" + (staleClassification.length - 10) : ""));
}

const classificationCoverage = {
  discovered: baselineItems.length,
  classified: baselineItems.length - unclassified.length,
};

// ── --verify / --report: re-extract the candidate inventory ────────────────

const diffInventory = (committed, fresh, label) => {
  const committedById = new Map(committed.map((item) => [item.id, item]));
  const freshById = new Map(fresh.map((item) => [item.id, item]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [id, item] of freshById) {
    const prior = committedById.get(id);
    if (!prior) added.push(id);
    else if (prior.contract?.fingerprint !== item.contract?.fingerprint
      || prior.contract?.membersHash !== item.contract?.membersHash) {
      changed.push(id);
    }
  }
  for (const id of committedById.keys()) {
    if (!freshById.has(id)) removed.push(id);
  }
  return { label, added: added.sort(), changed: changed.sort(), removed: removed.sort() };
};

let verification = null;
let candidateInventory = null;
let candidateStatus = null;
if (verify || report) {
  const typesPath = arg("types");
  const schemaPath = arg("schema");
  let typesText, schemaText;
  if (typesPath && schemaPath) {
    typesText = readFileSync(resolve(typesPath), "utf8");
    schemaText = readFileSync(resolve(schemaPath), "utf8");
    candidateStatus = { status: "ok", id: "override", versions: null };
  } else {
    const mode = arg("mode") ?? "pinned";
    const candidate = await loadCandidate(mode, { candidatePath: arg("candidate"), resultsDir });
    candidateStatus = { status: candidate.status, id: candidate.id ?? null, versions: candidate.versions ?? null, error: candidate.error ?? null };
    if (candidate.status !== "ok") {
      // In --verify mode this is fatal; in --report mode the extraction
      // failure is recorded and the latest pipeline's verdict phase reports
      // upstream-acquisition-failure.
      if (verify) fail("candidate not usable for inventory verification: " + (candidate.error ?? candidate.status));
    } else {
      typesText = readFileSync(candidate.paths.typesPath, "utf8");
      schemaText = readFileSync(candidate.paths.schemaPath, "utf8");
    }
  }
  if (typesText && schemaText) {
    candidateInventory = buildCandidateInventory({
      typesText,
      schema: JSON.parse(schemaText),
      spec,
      upstream: null,
    });
  }
}

if (verify && candidateInventory) {
  const apiDiff = diffInventory(baselines.api.items, candidateInventory.api, "upstream-api");
  const configDiff = diffInventory(baselines.config.items, candidateInventory.config, "upstream-config");
  verification = { api: apiDiff, config: configDiff };
  for (const diff of [apiDiff, configDiff]) {
    for (const id of diff.added) fail(diff.label + ": new upstream item not in baseline: " + id);
    for (const id of diff.changed) fail(diff.label + ": fingerprint drift not promoted into baseline: " + id);
    for (const id of diff.removed) fail(diff.label + ": baseline item no longer produced by discovery roots (removed upstream or undetectable): " + id);
  }
}

if (report) {
  mkdirSync(resultsDir, { recursive: true });
  const mode = arg("mode") ?? "pinned";
  const items = candidateInventory
    ? [...candidateInventory.api.map((item) => ({ ...item, kind: "api" })),
       ...candidateInventory.config.map((item) => ({ ...item, kind: "config" }))]
    : [];
  const classifiedItems = items.map((item) => ({
    id: item.id,
    kind: item.kind,
    fingerprint: item.contract?.fingerprint ?? null,
    profile: classRows[item.id]?.profile ?? null,
    target: classRows[item.id]?.target ?? null,
  }));
  writeFileSync(join(resultsDir, "inventory-" + mode + ".json"), JSON.stringify({
    formatVersion: 1,
    mode,
    checkedAt: new Date().toISOString(),
    candidateId: candidateStatus?.id ?? null,
    status: candidateInventory ? "ok" : "extraction-failed",
    error: candidateStatus?.error ?? null,
    items: classifiedItems,
    unclassified: classifiedItems.filter((item) => item.profile == null).map((item) => item.id),
  }, null, 2) + "\n");
  writeFileSync(join(resultsDir, "inventory-diff-" + mode + ".json"), JSON.stringify({
    formatVersion: 1,
    mode,
    checkedAt: new Date().toISOString(),
    candidateId: candidateStatus?.id ?? null,
    status: candidateInventory ? "ok" : "extraction-failed",
    api: candidateInventory ? diffInventory(baselines.api.items, candidateInventory.api, "upstream-api") : null,
    config: candidateInventory ? diffInventory(baselines.config.items, candidateInventory.config, "upstream-config") : null,
  }, null, 2) + "\n");
}

// ── Output ─────────────────────────────────────────────────────────────────

mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "resolved-inventory.json"), JSON.stringify({
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  items: resolved,
  deferred: baselines.api.deferred ?? [],
}, null, 2) + "\n");
writeFileSync(join(resultsDir, "inventory-check.json"), JSON.stringify({
  checkedAt: new Date().toISOString(),
  classificationCoverage,
  staleClassification,
  verification,
  pass: errors.length === 0,
}, null, 2) + "\n");

if (errors.length) {
  console.error("inventory violations:");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}
console.log(
  "resolved inventory OK: " + baselineItems.length + " items, "
  + classificationCoverage.classified + "/" + classificationCoverage.discovered + " classified, "
  + staleClassification.length + " stale classification rows"
  + (verify ? ", baseline re-extraction verified" : ""),
);
