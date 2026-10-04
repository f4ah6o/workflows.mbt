import { differentialProbes } from "./candidate-policy.mjs";
// Run verdict — classifies one compat run into a machine-readable outcome so
// "upstream could not be fetched" is never reported as "compatible", and a
// stale/partial result file is never evidence.
//
//   node compat/verdict.mjs --oracle latest [--results-dir <dir>]
//
// Reads the shared candidate plus the phase result files and emits
// compat-results/verdict-<oracle>.json. Verdicts:
//
//   compatible                      — every required phase passed on one candidate
//   contract-drift                  — upstream API/schema/typecheck surface changed
//   semantic-drift                  — probe traces or probe execution diverged
//   upstream-acquisition-failure    — candidate could not be resolved/installed
//   upstream-execution-failure      — upstream side could not start or run probes
//   local-runtime-failure           — the workflows.mbt side failed to run
//   incomplete-evidence             — missing/malformed/stale/mismatched evidence
//   hosted-not-performed            — hosted oracle has no result (credential-gated)
//
// Binding rules (a result file is rejected as evidence when):
//   - the file is missing, unparseable, or lacks required fields
//   - phase runIds disagree (phases ran under different runs)
//   - phase candidateIds disagree with the shared candidate (phases verified
//     different upstream tuples — the split-resolution failure mode)
//   - the differential covered fewer than the catalog's differential probes
//   - a phase is marked as an acquisition failure

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "latest";
if (!["pinned", "latest", "hosted"].includes(oracle)) {
  throw new Error("oracle must be pinned, latest, or hosted");
}
const resultsIndex = process.argv.indexOf("--results-dir");
const resultsDir = resultsIndex >= 0
  ? resolve(process.argv[resultsIndex + 1])
  : resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));

function loadPhase(name, requiredFields) {
  const path = join(resultsDir, name);
  if (!existsSync(path)) return { file: name, status: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { file: name, status: "malformed" };
  }
  for (const field of requiredFields) {
    if (parsed[field] == null) return { file: name, status: "malformed", missingField: field };
  }
  return { file: name, status: "ok", result: parsed };
}

// Hosted has no candidate/contract phases — it verifies the probe catalog only.
const candidate = oracle === "hosted" ? { status: "ok", result: null }
  : loadPhase(`candidate-${oracle}.json`, ["status", "id"]);
const catalogDifferential = differentialProbes(catalog, candidate.result).sort();
const contract = loadPhase(`drift-${oracle}.json`, ["mode", "checkedAt", "candidateId", "pass"]);
const differentialRequired = oracle === "hosted"
  ? ["oracle", "checkedAt", "probes", "pass"]
  : ["oracle", "checkedAt", "candidateId", "probes", "pass"];
const differential = loadPhase(`differential-${oracle}.json`, differentialRequired);
const typecheck = loadPhase(`typecheck-${oracle}.json`, ["candidateId", "pass"]);

const issues = [];
const phases = {};

function phaseStatus(phase, name, summaryFields = () => ({})) {
  if (phase.status !== "ok") {
    issues.push(`${name}: ${phase.status === "missing" ? "no result file" : "malformed result" + (phase.missingField ? " (missing " + phase.missingField + ")" : "")}`);
    phases[name] = { status: phase.status === "missing" ? "missing" : "malformed" };
    return "invalid";
  }
  const r = phase.result;
  // A phase may report a well-formed failure record instead of a verdict —
  // e.g. candidate resolution failed, or a local tool could not spawn. These
  // are never drift: pass/fail describes verified semantics only.
  if (r.phaseStatus === "upstream-acquisition-failure") {
    phases[name] = { status: "upstream-acquisition-failure", error: r.error ?? null };
    return "acquisition-failure";
  }
  if (r.phaseStatus === "upstream-execution-failure") {
    phases[name] = { status: "upstream-execution-failure", error: r.error ?? null };
    return "execution-failure";
  }
  if (r.phaseStatus === "toolchain-failure" || r.phaseStatus === "local-runtime-failure") {
    phases[name] = { status: r.phaseStatus, error: r.error ?? null };
    return "local-failure";
  }
  phases[name] = { status: r.pass ? "pass" : "fail", ...summaryFields(r) };
  return r.pass ? "pass" : "fail";
}

const contractOutcome = oracle === "hosted" ? "not-applicable"
  : phaseStatus(contract, "contract", (r) => ({ drift: r.drift ?? null }));
const differentialOutcome = phaseStatus(differential, "differential", (r) => ({
  probes: r.probes?.length ?? 0,
  differences: Object.keys(r.differences ?? {}).length,
  probeErrors: Object.keys(r.probeErrors ?? {}).length,
}));
const typecheckOutcome = typecheck.status === "missing" ? "not-run"
  : phaseStatus(typecheck, "typecheck");

// Hosted: no contract phase (the hosted oracle does not typecheck the
// contract), only the differential catalog. No result = not performed — never
// reported as compatible.
let verdict;
if (oracle === "hosted" && differentialOutcome === "invalid") {
  verdict = "hosted-not-performed";
  issues.push("no hosted differential evidence — the credential-gated canary has not run");
} else if (oracle !== "hosted" && candidate.status !== "ok") {
  // A missing/malformed candidate FILE is incomplete evidence — the resolver
  // never ran or its record is unusable. Only a candidate record that
  // documents a real acquisition failure counts as upstream-side failure.
  verdict = "incomplete-evidence";
} else if (oracle !== "hosted" && candidate.result.status !== "ok") {
  verdict = "upstream-acquisition-failure";
  issues.push("candidate unusable: " + (candidate.result?.error ?? candidate.result.status));
} else if (contractOutcome === "invalid" || differentialOutcome === "invalid" ||
    typecheckOutcome === "invalid") {
  verdict = "incomplete-evidence";
} else {
  // Phase binding: every phase must report the same run and the same
  // candidate, otherwise the phases verified different upstream tuples.
  const runIds = new Set();
  const candidateIds = new Set();
  for (const phase of [contract, differential, typecheck]) {
    if (phase.status === "ok") {
      if (phase.result.runId) runIds.add(phase.result.runId);
      if (phase.result.candidateId) candidateIds.add(phase.result.candidateId);
    }
  }
  if (runIds.size > 1) {
    issues.push("phase runIds disagree: " + [...runIds].join(", ") + " — phases ran under different runs");
  }
  if (candidateIds.size > 1) {
    issues.push("phase candidateIds disagree: " + [...candidateIds].join(", ") + " — phases verified different upstream tuples");
  }
  if (candidate.status === "ok" && candidate.result?.status === "ok" && candidateIds.size === 1
      && !candidateIds.has(candidate.result.id)) {
    issues.push("phase candidateId " + [...candidateIds][0] + " != shared candidate " + candidate.result.id);
  }
  if (issues.length > 0) {
    verdict = "incomplete-evidence";
  } else if (contractOutcome === "acquisition-failure" || differentialOutcome === "acquisition-failure" ||
      typecheckOutcome === "acquisition-failure") {
    verdict = "upstream-acquisition-failure";
  } else if (differentialOutcome === "execution-failure") {
    verdict = "upstream-execution-failure";
  } else if (differentialOutcome === "fail" &&
      (differential.result.sideErrors?.cloudflare ?? differential.result.sideErrors?.hosted ?? differential.result.phaseStatus === "upstream-execution-failure")) {
    verdict = "upstream-execution-failure";
    issues.push("upstream side failed: " + (differential.result.sideErrors?.cloudflare ?? differential.result.sideErrors?.hosted ?? differential.result.error));
  } else if (differentialOutcome === "fail" && differential.result.sideErrors?.workflowsMbt) {
    verdict = "local-runtime-failure";
    issues.push("workflows.mbt side failed: " + differential.result.sideErrors.workflowsMbt);
  } else if (typecheckOutcome === "local-failure" || contractOutcome === "local-failure" ||
      differentialOutcome === "local-failure") {
    // A local tool/harness failure is not evidence about upstream semantics —
    // never report it as contract or semantic drift.
    verdict = "local-runtime-failure";
  } else {
    // Coverage: a differential that ran zero or partial probes is incomplete,
    // not compatible.
    const covered = [...(differential.result.probes ?? [])].sort();
    const coverageOk = JSON.stringify(covered) === JSON.stringify(catalogDifferential);
    if (!coverageOk) {
      verdict = "incomplete-evidence";
      issues.push(`differential covered ${covered.length}/${catalogDifferential.length} catalog probes — partial evidence`);
    } else if (typecheckOutcome === "fail") {
      verdict = "contract-drift";
      issues.push("source typecheck failed against the candidate type surface");
    } else if (contractOutcome === "fail") {
      verdict = "contract-drift";
      const drift = contract.result.drift ?? {};
      issues.push(`contract drift: +${(drift.added ?? []).length} ~${(drift.changed ?? []).length} -${(drift.removed ?? []).length}`);
    } else if (differentialOutcome === "fail") {
      verdict = "semantic-drift";
      const names = [
        ...Object.keys(differential.result.differences ?? {}),
        ...Object.keys(differential.result.probeErrors ?? {}),
      ];
      issues.push("semantic drift on probes: " + names.join(", "));
    } else {
      verdict = "compatible";
    }
  }
}

// Optional docs-watch signal: changed official docs are an investigation
// trigger, never a compatibility failure.
let docsWatch = null;
const docsWatchPath = join(resultsDir, "docs-watch.json");
if (existsSync(docsWatchPath)) {
  try {
    const parsed = JSON.parse(readFileSync(docsWatchPath, "utf8"));
    docsWatch = {
      checkedAt: parsed.checkedAt ?? null,
      changed: (parsed.changed ?? []).length,
      unfetchable: (parsed.unfetchable ?? []).length,
    };
    if (docsWatch.changed > 0) {
      issues.push(`docs-watch: ${docsWatch.changed} upstream doc source(s) changed since baseline — investigate, not a compat failure`);
    }
  } catch {
    docsWatch = { malformed: true };
  }
}

const record = {
  formatVersion: 1,
  oracle,
  verdict,
  pass: verdict === "compatible",
  runId: differential.result?.runId ?? contract.result?.runId ?? null,
  checkedAt: new Date().toISOString(),
  commit: gitCommit(),
  candidate: candidate.status === "ok" && candidate.result ? {
    id: candidate.result.id,
    mode: candidate.result.mode,
    status: candidate.result.status,
    resolvedAt: candidate.result.resolvedAt ?? null,
    source: candidate.result.source ?? null,
    requested: candidate.result.requested ?? null,
    versions: candidate.result.versions ?? null,
    integrity: candidate.result.integrity ?? null,
    runtime: candidate.result.runtime ?? null,
    dependencyCount: candidate.result.dependencyCount ?? null,
    conditions: candidate.result.conditions ?? null,
  } : { status: candidate.status },
  phases,
  docsWatch,
  issues,
};
writeFileSync(join(resultsDir, `verdict-${oracle}.json`), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
if (!record.pass) process.exitCode = 1;
