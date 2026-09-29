// Coverage computation, committed baseline, and the PR regression gate
// (issue 20260929 §5, §9, §13).
//
//   node compat/coverage.mjs
//       validate the chain (check-capabilities), compute coverage, write
//       compat-results/coverage.json
//   node compat/coverage.mjs --update-baseline
//       regenerate compat/coverage-baseline.json from the current computed
//       coverage (preserves the human-authored `waivers` array). Reviewed-PR
//       operation only, like oracle/check.mjs --write.
//   node compat/coverage.mjs --gate --base <baseline.json>
//       compare current coverage against the BASE BRANCH's committed
//       baseline (never HEAD's — a PR may not approve its own regression by
//       editing its baseline). Any uncovered regression fails the gate.
//
// Counting rules (issue §9): the canonical unit is the requirement; a
// requirement counts in its owning profile's denominator exactly once when
// the profile is active and the derived target is in-scope. UNSUPPORTED
// stays in the denominator; excluded never enters it. All states are
// oracle-specific — pinned / latest / hosted are never merged into one
// number.
//
// Validator failure → coverage status INVALID and a non-zero exit: a normal
// coverage report on unvalidated data is never emitted.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";
import {
  COVERAGE_STATES,
  ORACLES,
  activeProfiles,
  currentFreshnessInputs,
  deriveRequirementTarget,
  computeRelevantInputs,
  fingerprintIsStale,
  loadDiscoverySpec,
  probeVerdictFor,
  reduceProbeVerdicts,
  sha256File,
} from "./coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });
const inventoryDir = process.env.WORKFLOWS_MBT_INVENTORY_DIR
  ? resolve(process.env.WORKFLOWS_MBT_INVENTORY_DIR)
  : join(root, "compat/inventory");
const baselinePath = process.env.WORKFLOWS_MBT_COVERAGE_BASELINE
  ? resolve(process.env.WORKFLOWS_MBT_COVERAGE_BASELINE)
  : join(root, "compat/coverage-baseline.json");

const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const updateBaseline = process.argv.includes("--update-baseline");
const gate = process.argv.includes("--gate");
const gateBasePath = arg("base") ? resolve(arg("base")) : null;

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

// ── Validator gate ─────────────────────────────────────────────────────────
// Coverage is computed only on a validated chain: check-capabilities is the
// validator of record for capabilities ↔ requirements ↔ probes ↔ inventory.

const validator = spawnSync(process.execPath, [join(root, "compat/check-capabilities.mjs")], {
  stdio: "inherit",
});

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

if (validator.status !== 0) {
  const invalid = {
    formatVersion: 1,
    status: "INVALID",
    generatedAt: new Date().toISOString(),
    commit: gitCommit(),
    reason: "check-capabilities.mjs failed (status " + validator.status + ") — coverage computed on unvalidated data is not emitted",
  };
  writeFileSync(join(resultsDir, "coverage.json"), JSON.stringify(invalid, null, 2) + "\n");
  console.error("coverage status: INVALID — validator failed, no coverage report emitted");
  process.exit(validator.status ?? 1);
}

// ── Requirements ───────────────────────────────────────────────────────────

const requirements = (matrix.requirements ?? []).map((req) => ({
  id: req.id,
  profile: req.id.split(".")[1] ?? null,
  target: deriveRequirementTarget(req, classification.items ?? {}),
  requiredProbes: req.requiredProbes ?? [],
  unsupported: req.unsupported ?? null,
}));
// Target requirements: owning profile active + derived scope in-scope.
const targetRequirements = requirements.filter((req) => req.target === "in-scope" && active.has(req.profile));

// ── Per-oracle derivation ──────────────────────────────────────────────────

function blockedReason(probeErrors) {
  const sides = Object.keys(probeErrors ?? {});
  if (sides.length > 0 && sides.every((side) => side === "cloudflare" || side === "hosted")) {
    return "upstream-observed-limitation";
  }
  return "execution-error: " + (sides.join("+") || "unknown");
}

const oracleCoverage = {};
for (const oracle of ORACLES) {
  const result = loadResult("differential-" + oracle + ".json");
  if (!result) {
    oracleCoverage[oracle] = { measured: false };
    continue;
  }
  const inputs = currentFreshnessInputs(root, resultsDir, oracle, { inventoryDir });
  const stale = fingerprintIsStale(result.fingerprint, inputs);
  const verdicts = {};
  const reasons = {};
  for (const probe of catalog.probes) {
    verdicts[probe.id] = probeVerdictFor(result, probe.id, { stale });
    if (verdicts[probe.id] === "BLOCKED") reasons[probe.id] = blockedReason(result.probeErrors?.[probe.id]);
  }
  const reqStates = {};
  for (const req of requirements) {
    const perProbe = (req.requiredProbes ?? []).map((probeId) => verdicts[probeId] ?? "UNTESTED");
    const state = reduceProbeVerdicts(perProbe, { declaredUnsupported: !!req.unsupported });
    reqStates[req.id] = {
      state,
      verdicts: Object.fromEntries((req.requiredProbes ?? []).map((probeId, i) => [probeId, perProbe[i]])),
      ...(state === "BLOCKED" ? { blockedReasons: reasons } : {}),
      ...(state === "UNSUPPORTED" && req.unsupported ? { unsupportedReason: req.unsupported.reason } : {}),
    };
  }
  oracleCoverage[oracle] = {
    measured: true,
    fresh: !stale,
    runId: result.runId ?? null,
    checkedAt: result.checkedAt ?? null,
    candidateId: result.candidateId ?? result.fingerprint?.upstreamCandidate?.id ?? null,
    lastVerifiedEvidence: result.fingerprint
      ? { runId: result.fingerprint.runId, checkedAt: result.fingerprint.runTimestamp, fresh: !stale }
      : null,
    probeVerdicts: verdicts,
    probeErrors: result.probeErrors ?? {},
    notRun: catalog.probes.filter((probe) => !(result.probes ?? []).includes(probe.id)).map((probe) => probe.id),
    requirements: reqStates,
  };
}

// ── Metrics (issue §9) ─────────────────────────────────────────────────────

// Inventory classification coverage: classified / discovered upstream items.
const baselineItems = [...(baselines.api?.items ?? []), ...(baselines.config?.items ?? []), ...(baselines.semantic?.items ?? [])];
const classified = baselineItems.filter((item) => classification.items?.[item.id]?.profile != null);

const profiles = {};
for (const name of spec.profileOrder ?? []) {
  const lifecycle = spec.profiles[name]?.lifecycle;
  const target = targetRequirements.filter((req) => req.profile === name);
  const cell = {
    lifecycle,
    denominator: lifecycle === "active" ? target.length : null,
    requirements: lifecycle === "active" ? target.map((req) => req.id).sort() : [],
    oracles: {},
  };
  for (const oracle of ORACLES) {
    const coverage = oracleCoverage[oracle];
    if (lifecycle !== "active" || !coverage.measured) continue;
    const states = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0]));
    let executed = 0;
    let passed = 0;
    for (const req of target) {
      const state = coverage.requirements[req.id].state;
      states[state] += 1;
      const ran = (req.requiredProbes ?? []).some(
        (probeId) => ["VERIFIED", "DIVERGENT", "BLOCKED"].includes(coverage.probeVerdicts[probeId]),
      );
      if (ran) executed += 1;
      if (state === "VERIFIED") passed += 1;
    }
    cell.oracles[oracle] = {
      numerator: states.VERIFIED,
      denominator: target.length,
      states,
      verifiedRequirements: target.filter((req) => coverage.requirements[req.id].state === "VERIFIED").map((req) => req.id).sort(),
      functionalCoverage: { executed, passed },
    };
  }
  profiles[name] = cell;
}

// Practical scenario coverage (issue §14): committed scenario registry vs
// the scenario result files this checkout actually produced.
const scenarioRegistry = loadJson(join(root, "compat/scenarios.json"))?.scenarios ?? [];
const scenarioStates = {};
for (const scenario of scenarioRegistry) {
  const result = loadResult(scenario.result);
  if (!result) { scenarioStates[scenario.id] = "not-run"; continue; }
  const pass = result[scenario.passField] === scenario.passEquals;
  let stale = false;
  if (result.fingerprint) {
    stale = fingerprintIsStale(result.fingerprint, currentFreshnessInputs(root, resultsDir, scenario.oracle ?? "pinned", { inventoryDir }));
  }
  scenarioStates[scenario.id] = stale ? "stale" : pass ? "passed" : "failed";
}
const scenarios = {
  target: scenarioRegistry.map((scenario) => scenario.id),
  supported: scenarioRegistry.filter((scenario) => scenarioStates[scenario.id] === "passed").map((scenario) => scenario.id),
  states: scenarioStates,
};

const candidates = {};
for (const oracle of ORACLES) {
  candidates[oracle] = oracleCoverage[oracle].measured ? oracleCoverage[oracle].candidateId : null;
}

const coverage = {
  formatVersion: 1,
  status: "ok",
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  classificationCoverage: {
    discovered: baselineItems.length,
    classified: classified.length,
  },
  requirements: Object.fromEntries(requirements.map((req) => [req.id, {
    profile: req.profile,
    target: req.target,
    requiredProbes: req.requiredProbes,
    ...(req.unsupported ? { unsupportedReason: req.unsupported.reason } : {}),
  }])),
  profiles,
  oracles: Object.fromEntries(ORACLES.map((oracle) => {
    const cov = oracleCoverage[oracle];
    if (!cov.measured) return [oracle, { measured: false }];
    return [oracle, {
      measured: true,
      fresh: cov.fresh,
      runId: cov.runId,
      checkedAt: cov.checkedAt,
      candidateId: cov.candidateId,
      lastVerifiedEvidence: cov.lastVerifiedEvidence,
      probeErrors: cov.probeErrors,
      notRun: cov.notRun,
      probeVerdicts: cov.probeVerdicts,
      requirements: cov.requirements,
    }];
  })),
  scenarios,
  candidates,
};

writeFileSync(join(resultsDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");

// ── Baseline ───────────────────────────────────────────────────────────────

function baselineDocument() {
  const doc = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    matrixHash: sha256File(join(root, "compat/capabilities.json")),
    inventoryHash: computeRelevantInputs(root, null, { inventoryDir }).inventoryHash,
    candidates,
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, cell]) => [name, {
      lifecycle: cell.lifecycle,
      denominator: cell.denominator,
      requirements: cell.requirements,
      oracles: cell.oracles,
    }])),
    waivers: loadJson(baselinePath)?.waivers ?? [],
  };
  return doc;
}

if (updateBaseline) {
  const doc = baselineDocument();
  writeFileSync(baselinePath, JSON.stringify(doc, null, 2) + "\n");
  console.log("wrote " + baselinePath + " (waivers preserved: " + doc.waivers.length + ")");
}

// ── Regression gate (issue §13) ────────────────────────────────────────────
// Compares current coverage against the BASE branch's committed baseline.
// HEAD's own coverage-baseline.json is the proposed baseline: it must match
// current coverage exactly, and intentional regressions need a scoped waiver
// matched 1:1 (unused waivers also fail).

function regressionKind(metric) {
  return metric === "denominator" ? "denominator-shrink" : "metric-drop";
}

function runGate(basePath) {
  const problems = [];
  const notes = [];
  const regressions = [];

  let base = null;
  if (basePath && existsSync(basePath)) {
    try {
      base = loadJson(basePath);
    } catch {
      base = null;
      notes.push("base baseline file unreadable — treated as no-baseline");
    }
  }
  if (!base) {
    notes.push("no base baseline — first adoption, nothing to compare");
  } else {
    // Denominator shrink (oracle-independent): any profile whose target
    // requirement set lost entries vs the base baseline.
    for (const [name, baseCell] of Object.entries(base.profiles ?? {})) {
      if (baseCell.lifecycle !== "active") continue;
      const current = profiles[name];
      const currentReqs = new Set(current?.requirements ?? []);
      const lost = (baseCell.requirements ?? []).filter((id) => !currentReqs.has(id)).sort();
      const after = current?.denominator ?? 0;
      if (lost.length > 0 || after < (baseCell.denominator ?? 0)) {
        regressions.push({
          kind: "denominator-shrink",
          oracle: "*",
          profile: name,
          metric: "denominator",
          requirementIds: lost,
          before: baseCell.denominator,
          after,
        });
      }
    }
    // Numerator drop: per profile × oracle the base measured and the current
    // run also measured (an unmeasured oracle is noted, not a regression).
    for (const [name, baseCell] of Object.entries(base.profiles ?? {})) {
      const current = profiles[name];
      for (const [oracle, baseOracle] of Object.entries(baseCell.oracles ?? {})) {
        if (!current?.oracles?.[oracle]) {
          notes.push(name + "@" + oracle + ": not measured in current coverage — cell skipped");
          continue;
        }
        const currentVerified = new Set(current.oracles[oracle].verifiedRequirements ?? []);
        const dropped = (baseOracle.verifiedRequirements ?? []).filter((id) => !currentVerified.has(id)).sort();
        const after = current.oracles[oracle].numerator;
        if (dropped.length > 0 || after < (baseOracle.numerator ?? 0)) {
          regressions.push({
            kind: "metric-drop",
            oracle,
            profile: name,
            metric: "verified-numerator",
            requirementIds: dropped,
            before: baseOracle.numerator,
            after,
          });
        }
      }
    }
    // Upstream pin change: a changed candidate identity is a deliberate
    // update that must be acknowledged by an upstream-pin-update waiver; it
    // never auto-permits the metric records above.
    for (const oracle of ORACLES) {
      const before = base.candidates?.[oracle] ?? null;
      const after = candidates[oracle] ?? null;
      if (before && after && before !== after) {
        regressions.push({
          kind: "upstream-pin-update",
          oracle,
          profile: "*",
          metric: "candidate",
          requirementIds: ["*"],
          before,
          after,
        });
      }
    }
  }

  // 1:1 exhaustive waiver matching.
  const waivers = loadJson(baselinePath)?.waivers ?? [];
  const waiverUsed = new Set();
  const unmatched = [];
  for (const record of regressions) {
    const index = waivers.findIndex((waiver, i) => !waiverUsed.has(i)
      && waiver.kind === record.kind
      && waiver.oracle === record.oracle
      && waiver.profile === record.profile
      && waiver.metric === record.metric
      && JSON.stringify([...(waiver.scope ?? [])].sort()) === JSON.stringify(record.requirementIds)
      && waiver.before === record.before
      && waiver.after === record.after);
    if (index >= 0) waiverUsed.add(index);
    else unmatched.push(record);
  }
  const unusedWaivers = waivers.filter((_, i) => !waiverUsed.has(i));

  // Proposed baseline consistency: HEAD's coverage-baseline.json must equal
  // the current computed coverage (for oracles this run measured).
  const proposed = loadJson(baselinePath);
  if (proposed) {
    for (const [name, cell] of Object.entries(proposed.profiles ?? {})) {
      const current = profiles[name];
      if (!current) { problems.push("proposed baseline has profile " + name + " not present in current coverage"); continue; }
      if (cell.denominator !== current.denominator
        || JSON.stringify(cell.requirements) !== JSON.stringify(current.requirements)) {
        problems.push("proposed baseline " + name + " denominator/requirements do not match current coverage");
      }
      for (const [oracle, cellOracle] of Object.entries(cell.oracles ?? {})) {
        const currentOracle = current.oracles[oracle];
        if (!currentOracle) {
          notes.push("proposed baseline " + name + "@" + oracle + " not measured this run — cannot verify");
          continue;
        }
        if (cellOracle.numerator !== currentOracle.numerator
          || JSON.stringify(cellOracle.states) !== JSON.stringify(currentOracle.states)
          || JSON.stringify(cellOracle.verifiedRequirements) !== JSON.stringify(currentOracle.verifiedRequirements)) {
          problems.push("proposed baseline " + name + "@" + oracle + " does not match current coverage");
        }
      }
    }
    for (const oracle of ORACLES) {
      const current = candidates[oracle];
      if (current == null) continue; // not measured this run
      if (proposed.candidates?.[oracle] !== current) {
        problems.push("proposed baseline candidate for " + oracle + " (" + proposed.candidates?.[oracle] + ") does not match current run (" + current + ")");
      }
    }
  }

  for (const record of unmatched) {
    problems.push("uncovered regression: " + JSON.stringify(record));
  }
  for (const waiver of unusedWaivers) {
    problems.push("waiver did not match any regression: " + JSON.stringify(waiver));
  }

  const record = {
    status: problems.length === 0 ? (base ? "pass" : "no-baseline") : "fail",
    checkedAt: new Date().toISOString(),
    regressions,
    waiversMatched: waiverUsed.size,
    problems,
    notes,
  };
  writeFileSync(join(resultsDir, "coverage-gate.json"), JSON.stringify(record, null, 2) + "\n");
  console.log("coverage gate: " + record.status + (problems.length ? " — " + problems.length + " problem(s)" : ""));
  for (const problem of problems) console.error("- " + problem);
  return problems.length === 0 ? 0 : 1;
}

const summary = Object.fromEntries(Object.entries(profiles).map(([name, cell]) => [name, {
  lifecycle: cell.lifecycle,
  denominator: cell.denominator,
  oracles: Object.fromEntries(Object.entries(cell.oracles).map(([oracle, o]) => [oracle, o.numerator + "/" + o.denominator])),
}]));
console.log("coverage: " + JSON.stringify({ classification: coverage.classificationCoverage, profiles: summary, scenarios: { supported: scenarios.supported.length, target: scenarios.target.length } }, null, 2));

if (gate) {
  if (!gateBasePath) {
    console.error("--gate requires --base <baseline.json>");
    process.exit(2);
  }
  process.exit(runGate(gateBasePath));
}
