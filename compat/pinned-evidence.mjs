import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildResultFingerprint, computeRelevantInputs, fingerprintIsStale, sha256File } from "./coverage-model.mjs";

export const PINNED_REQUIRED_PHASES = ["candidate", "typecheck", "candidate-typecheck", "contract", "differential", "capabilities"];
const outputs = {
  candidate: "candidate-pinned.json",
  "candidate-typecheck": "typecheck-pinned.json",
  contract: "drift-pinned.json",
  differential: "differential-pinned.json",
};

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function createPinnedEvidenceRecorder({ rootDir, resultsDir, runId, inventoryDir }) {
  const record = { formatVersion: 1, oracle: "pinned", runId, candidateId: null,
    fingerprint: null, complete: false, phases: [] };
  const save = () => writeFileSync(join(resultsDir, "run-pinned.json"), JSON.stringify(record, null, 2) + "\n");
  mkdirSync(resultsDir, { recursive: true });
  save();
  return (phase) => {
    if (!PINNED_REQUIRED_PHASES.includes(phase.name)) return;
    if (phase.name === "candidate") {
      const candidate = readJson(join(resultsDir, outputs.candidate));
      record.candidateId = candidate?.id ?? null;
      if (candidate?.status === "ok") {
        record.fingerprint = buildResultFingerprint({ runId, oracle: "pinned", candidate,
          relevantInputs: computeRelevantInputs(rootDir, candidate, { inventoryDir }) });
      }
    }
    let outputHash = null;
    if (outputs[phase.name]) {
      try { outputHash = sha256File(join(resultsDir, outputs[phase.name])); } catch { /* Missing output is not evidence. */ }
    }
    record.phases.push({ ...phase, outputHash });
    record.complete = PINNED_REQUIRED_PHASES.every((name) => record.phases.some((p) => p.name === name));
    save();
  };
}

// Both the machine verdict and the report use the same complete evidence gate.
export function validatePinnedEvidence({ rootDir, resultsDir, runId, candidateId, inventoryDir }) {
  const issues = [];
  const invalid = (message) => ({ status: "unverified", issues: [message] });
  const record = readJson(join(resultsDir, "run-pinned.json"));
  if (record?.formatVersion !== 1 || record.oracle !== "pinned" || record.complete !== true
      || !record.runId || !record.candidateId || !Array.isArray(record.phases)) {
    return invalid("missing or incomplete pinned phase receipts");
  }
  if ((runId != null && record.runId !== runId) || (candidateId != null && record.candidateId !== candidateId)) {
    return invalid("pinned phase receipts do not match the verdict run/candidate");
  }
  const candidate = readJson(join(resultsDir, outputs.candidate));
  if (candidate?.status !== "ok" || candidate.id !== record.candidateId || candidate.runId !== record.runId) {
    return invalid("candidate does not match the evidence run");
  }
  for (const name of PINNED_REQUIRED_PHASES) {
    const receipts = record.phases.filter((phase) => phase?.name === name);
    if (receipts.length !== 1 || !Number.isInteger(receipts[0].status)) return invalid("missing or malformed " + name + " receipt");
    const receipt = receipts[0];
    if (receipt.status !== 0 || receipt.error) issues.push(name + " process failed");
    if (!outputs[name]) continue;
    const path = join(resultsDir, outputs[name]);
    const result = readJson(path);
    if (!result || result.runId !== record.runId
        || (name !== "candidate" && result.candidateId !== record.candidateId)) {
      return invalid(name + " output missing or not bound to the evidence run/candidate");
    }
    if (!receipt.outputHash || sha256File(path) !== receipt.outputHash) return invalid(name + " output changed after verification");
    if (name !== "candidate" && (result.pass !== true || result.phaseStatus)) issues.push(name + " output did not pass");
  }
  const inputs = computeRelevantInputs(rootDir, candidate, { inventoryDir });
  if (record.fingerprint?.runId !== record.runId || record.fingerprint?.oracle !== "pinned"
      || fingerprintIsStale(record.fingerprint, inputs)) {
    return { status: "stale", issues: ["pinned run inputs no longer match"] };
  }
  return { status: "ok", pass: issues.length === 0, issues };
}
