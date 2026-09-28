// Emits a verified update candidate when the latest oracle is compatible —
// and an explicit non-candidate record when it is not.
//
//   node compat/update-candidate.mjs [--oracle latest]
//
// Reads compat-results/verdict-<oracle>.json and candidate-<oracle>.json and
// writes compat-results/update-candidate-<oracle>.json plus, when the verdict
// is `compatible`, compat-results/proposed-manifest.json.
//
// Policy:
//   - compatible: propose the observed upstream tuple as the new pinned
//     baseline. The proposal is a file under compat-results/ — applying it
//     (editing compat/oracle/manifest.json + package.json + lockfile and
//     re-running the pinned suite) is a manual, reviewable step. CI never
//     promotes it.
//   - contract-drift / semantic-drift / incomplete-evidence: no pin proposal.
//     The output points at the drift record packet and marks
//     requiresImplementationChange — a fix must land and re-verify before the
//     baseline can move.
//   - upstream-acquisition-failure / upstream-execution-failure /
//     hosted-not-performed: no pin proposal; upstream instability never moves
//     the baseline.
//   - compatibility_date changes are deliberately not bundled: the proposal
//     carries the candidate's pin tuple only, and the reviewer decides on the
//     compatibilityDate bump separately.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsDirFor } from "./candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resultsDirFor(root);
mkdirSync(resultsDir, { recursive: true });
const oracleIndex = process.argv.indexOf("--oracle");
const oracle = oracleIndex >= 0 ? process.argv[oracleIndex + 1] : "latest";

function load(name) {
  const path = join(resultsDir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const verdict = load(`verdict-${oracle}.json`);
const candidate = load(`candidate-${oracle}.json`);
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

const outPath = join(resultsDir, `update-candidate-${oracle}.json`);
const now = new Date().toISOString();

let record;
if (!verdict) {
  record = { status: "no-update", reason: "no verdict file — run `npm run compat:latest` first" };
} else if (verdict.verdict === "compatible" && candidate?.status === "ok") {
  const proposed = {
    ...manifest,
    wrangler: candidate.versions.wrangler,
    workersTypes: candidate.versions.workersTypes,
    workerd: candidate.versions.workerd,
    verifiedAt: now.slice(0, 10),
  };
  writeFileSync(join(resultsDir, "proposed-manifest.json"), JSON.stringify(proposed, null, 2) + "\n");
  record = {
    status: "proposed",
    reason: "latest oracle compatible — pinned baseline update candidate generated",
    proposed: {
      wrangler: candidate.versions.wrangler,
      "@cloudflare/workers-types": candidate.versions.workersTypes,
      workerd: candidate.versions.workerd,
    },
    current: {
      wrangler: manifest.wrangler,
      "@cloudflare/workers-types": manifest.workersTypes,
      workerd: manifest.workerd,
    },
    changed: manifest.wrangler !== candidate.versions.wrangler
      || manifest.workersTypes !== candidate.versions.workersTypes
      || manifest.workerd !== candidate.versions.workerd,
    proposalFile: "compat-results/proposed-manifest.json",
    applySteps: [
      "review compat-results/proposed-manifest.json",
      "update package.json pinned devDependencies to the candidate tuple",
      "npm install (regenerates package-lock.json)",
      "copy proposed manifest over compat/oracle/manifest.json",
      "npm run compat:pinned && npm test  # re-verify under the new pin",
      "open a PR — never auto-merge",
    ],
    verdict: verdict.verdict,
    runId: verdict.runId,
    candidateId: candidate.id,
  };
} else if (["contract-drift", "semantic-drift", "incomplete-evidence"].includes(verdict?.verdict)) {
  record = {
    status: "blocked",
    requiresImplementationChange: true,
    reason: `verdict ${verdict.verdict} — fix and re-verify before the baseline can move`,
    driftPacket: "compat-results/drift-*.md",
    verdict: verdict.verdict,
    issues: verdict.issues ?? [],
  };
} else {
  record = {
    status: "no-update",
    reason: `verdict ${verdict?.verdict} — upstream-side failure/omission never moves the baseline`,
    verdict: verdict?.verdict ?? null,
    issues: verdict?.issues ?? [],
  };
}

record.oracle = oracle;
record.generatedAt = now;
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
