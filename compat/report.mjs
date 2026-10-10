import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "compat-results");
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

// Re-validate the chain first so the report only ever renders evidence the
// result files actually support. coverage.mjs runs check-capabilities and
// exits non-zero on validator failure — a non-zero status that fell through
// to the render would produce a normal report built on unvalidated data
// (coverage status INVALID, issue §11).
const coverageCheck = spawnSync(process.execPath, [join(root, "compat/coverage.mjs")], {
  stdio: "inherit",
});
if (coverageCheck.status !== 0) {
  console.error("coverage.mjs failed (status " + coverageCheck.status + ") — coverage INVALID, not rendering a report on unvalidated data");
  process.exit(coverageCheck.status ?? 1);
}

function load(name) {
  const path = join(out, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const differentialPinned = load("differential-pinned.json");
const differentialLatest = load("differential-latest.json");
const driftPinned = load("drift-pinned.json");
const driftLatest = load("drift-latest.json");
const verdictPinned = load("verdict-pinned.json");
const verdictLatest = load("verdict-latest.json");
const verdictHosted = load("verdict-hosted.json");
const updateCandidate = load("update-candidate-latest.json");
const docsWatch = load("docs-watch.json");
const scenario = load("scenario-consumer.json");
const capabilities = load("capabilities.json");
const coverage = load("coverage.json");
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

// Contract drift and semantic probe results are distinct axes: upstream can
// break either one independently, so the report names the combination rather
// than collapsing to a single compatibility boolean.
function oracleOutcome(contract, semantic) {
  const contractText = contract ? (contract.pass ? "contract clean" : "contract drift") : "contract not run";
  const semanticText = semantic ? (semantic.pass ? "semantic probes pass" : "semantic probes failed") : "semantic probes not run";
  return contractText + " + " + semanticText;
}

const EVIDENCE_LABELS = [
  ["implemented", "impl"],
  ["repository_tested", "repo-tested"],
  ["pinned_differential", "pinned"],
  ["latest_differential", "latest"],
  ["hosted_differential", "hosted"],
  ["intentionally_unsupported", "known-diff"],
];

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
  "",
  "## Outcome",
  "",
  "- pinned oracle: " + (verdictPinned
      ? "verdict **" + verdictPinned.verdict + "** (run " + (verdictPinned.runId ?? "?")
        + ", candidate " + (verdictPinned.candidate?.id ?? "?") + ")"
      : oracleOutcome(driftPinned, differentialPinned) + " — no pinned verdict file"),
  "- latest oracle: " + (verdictLatest
      ? `verdict **${verdictLatest.verdict}** (run ${verdictLatest.runId ?? "?"}, candidate ${verdictLatest.candidate?.id ?? "?"})`
      : oracleOutcome(driftLatest, differentialLatest) + " — no verdict file"),
  "- hosted oracle: " + (verdictHosted
      ? `verdict **${verdictHosted.verdict}**`
      : "no verdict (credential-gated canary has not run)"),
  ...(updateCandidate ? [
    "- update candidate: " + updateCandidate.status
      + (updateCandidate.status === "proposed"
        ? ` — ${updateCandidate.current?.wrangler} -> ${updateCandidate.proposed?.wrangler} (proposal: ${updateCandidate.proposalFile}; apply is manual)`
        : updateCandidate.status === "blocked"
          ? " — requiresImplementationChange (see drift packet)"
          : updateCandidate.reason ? ` — ${updateCandidate.reason}` : ""),
  ] : []),
  ...(docsWatch ? [
    "- docs watch: " + (docsWatch.changed?.length
      ? `${docsWatch.changed.length} source(s) changed — investigation trigger`
      : "unchanged"),
  ] : []),
  ...(scenario ? [
    "- practical scenario: " + scenario.finalStatus
      + ` (charge calls: ${scenario.observations?.chargeCalls}, applied: ${scenario.observations?.chargeAppliedRecords}, kill points: ${(scenario.killPoints ?? []).map((k) => k.at).join(", ")})`,
  ] : []),
  "",
  "## Differential probes",
  "",
  ...probeLines("pinned", differentialPinned),
  ...probeLines("latest", differentialLatest),
  "",
  "## Contract drift",
  "",
  ...(driftLatest ?? driftPinned ? [
    "- checked versions: " + JSON.stringify((driftLatest ?? driftPinned).versions),
    "- added: " + ((driftLatest ?? driftPinned).drift.added.length ? (driftLatest ?? driftPinned).drift.added.join(", ") : "none"),
    "- removed: " + ((driftLatest ?? driftPinned).drift.removed.length ? (driftLatest ?? driftPinned).drift.removed.join(", ") : "none"),
    "- changed: " + ((driftLatest ?? driftPinned).drift.changed.length ? (driftLatest ?? driftPinned).drift.changed.join(", ") : "none"),
  ] : ["- not run"]),
  "",
  "## Coverage",
  "",
  ...coverageSection(coverage),
  "",
  "## Capability matrix",
  "",
];

// Per-oracle coverage tables (issue §11): verified/divergent/unsupported/
// untested/blocked/stale per active profile, with probe errors, blocked
// reasons, stale requirements, and unexecuted probes named explicitly.
function coverageSection(cov) {
  if (!cov || cov.status !== "ok") {
    return ["- coverage: " + (cov?.status ?? "not computed") + " — run compat/coverage.mjs"];
  }
  const out = [
    "- classification coverage: " + cov.classificationCoverage.classified + "/" + cov.classificationCoverage.discovered + " upstream items classified",
    "- practical scenario coverage: " + cov.scenarios.supported.length + "/" + cov.scenarios.target.length,
  ];
  for (const oracle of ["pinned", "latest", "hosted"]) {
    const cell = cov.oracles?.[oracle];
    out.push("", "### " + oracle + " oracle");
    if (!cell?.measured) {
      out.push("", "- no result file — not measured");
      continue;
    }
    out.push(
      "",
      "- run " + (cell.runId ?? "?") + " · " + (cell.checkedAt ?? "?") + " · evidence " + (cell.fresh ? "fresh" : "STALE")
        + (cell.candidateId ? " · candidate " + cell.candidateId.slice(0, 24) : ""),
      "",
      "| Profile | Verified | Divergent | Unsupported | Untested | Blocked | Stale | Total | Coverage |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const [name, profile] of Object.entries(cov.profiles ?? {})) {
      const o = profile.oracles?.[oracle];
      if (!o) {
        out.push("| " + name + " | " + (profile.lifecycle === "deferred" ? "deferred" : "not measured") + " | — | — | — | — | — | — | — |");
        continue;
      }
      const s = o.states;
      const pct = o.denominator ? Math.round((o.numerator / o.denominator) * 100) + "%" : "n/a";
      out.push("| " + name + " | " + s.VERIFIED + " | " + s.DIVERGENT + " | " + s.UNSUPPORTED + " | " + s.UNTESTED + " | " + s.BLOCKED + " | " + s.STALE + " | " + o.denominator + " | " + pct + " |");
    }
    const errs = Object.entries(cell.probeErrors ?? {});
    const blocked = Object.entries(cell.requirements ?? {}).filter(([, r]) => r.state === "BLOCKED");
    const stale = Object.entries(cell.requirements ?? {}).filter(([, r]) => r.state === "STALE");
    const divergent = Object.entries(cell.requirements ?? {}).filter(([, r]) => r.state === "DIVERGENT");
    out.push(
      "",
      "- probe errors: " + (errs.length ? errs.map(([p, e]) => p + " (" + Object.keys(e).join("+") + ")").join(", ") : "none"),
      "- not run: " + (cell.notRun?.length ? cell.notRun.join(", ") : "none"),
      "- divergent: " + (divergent.length ? divergent.map(([id]) => id).join(", ") : "none"),
      "- blocked: " + (blocked.length
        ? blocked.map(([id, r]) => id + " (" + Object.entries(r.blockedReasons ?? {}).map(([p, b]) => p + ": " + b).join("; ") + ")").join(", ")
        : "none"),
      "- stale: " + (stale.length ? stale.map(([id]) => id).join(", ") : "none"),
    );
  }
  return out;
}

if (!capabilities) {
  lines.push("- capabilities.json not resolved — run compat/check-capabilities.mjs");
} else {
  lines.push(
    "| Capability | Category | Evidence |",
    "| --- | --- | --- |",
    ...capabilities.capabilities.map((row) => {
      const evidence = EVIDENCE_LABELS.filter(([key]) => row.declaredSupport?.[key])
        .map(([, label]) => label)
        .join(", ") || "none";
      const suffix = row.knownDifference ? " — " + row.knownDifference : "";
      return "| " + row.id + " | " + row.category + " | " + evidence + suffix + " |";
    }),
    "",
    "Verified at: " + JSON.stringify(capabilities.verifiedAt) + " · upstream: " + JSON.stringify(capabilities.upstream),
  );
}
lines.push("", "## Known differences", "", known, "");
const report = lines.join("\n");
writeFileSync(join(out, "report.md"), report);
console.log(report);
