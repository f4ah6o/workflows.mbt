// Validates compat/capabilities.json against the probe catalog and the
// differential results actually produced. The matrix is the source of truth
// for evidence state; this script makes it impossible to claim differential
// coverage a run did not deliver.
//
//   node compat/check-capabilities.mjs [--strict]
//
// --strict also fails when pinned/latest result files are missing entirely.
// Without it, a missing result file only forces the corresponding evidence
// flags off (it records "not executed" rather than failing).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "compat-results");
const strict = process.argv.includes("--strict");

const catalog = JSON.parse(readFileSync(join(root, "compat/probes/catalog.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));

function loadResult(name) {
  const path = join(resultsDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
const differential = {
  pinned: loadResult("differential-pinned.json"),
  latest: loadResult("differential-latest.json"),
  hosted: loadResult("differential-hosted.json"),
};
const driftPinned = loadResult("drift-pinned.json");
const driftLatest = loadResult("drift-latest.json");
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));

const errors = [];
const fail = (message) => errors.push(message);

// Catalog -> matrix coverage: every probe capability resolves to a row, and
// each row's probes/skippedProbes lists are exactly the catalog probes mapped
// to it.
const capabilityToProbes = new Map();
const capabilityToSkipped = new Map();
for (const probe of catalog.probes) {
  for (const capability of probe.capabilities ?? []) {
    const target = probe.differential === false ? capabilityToSkipped : capabilityToProbes;
    if (!target.has(capability)) target.set(capability, []);
    target.get(capability).push(probe.id);
  }
}

const rowById = new Map();
for (const row of matrix.capabilities ?? []) {
  if (!row.id || typeof row.id !== "string") fail("capability row missing id: " + JSON.stringify(row));
  if (rowById.has(row.id)) fail("duplicate capability id: " + row.id);
  rowById.set(row.id, row);
  if (!matrix.categories?.includes(row.category)) fail(row.id + ": unknown category " + row.category);
  if (!Array.isArray(row.probes)) fail(row.id + ": probes must be an array");
  if (row.evidence?.intentionally_unsupported && !row.knownDifference) {
    fail(row.id + ": intentionally_unsupported requires a knownDifference note");
  }
}

for (const [capability, probes] of capabilityToProbes) {
  const row = rowById.get(capability);
  if (!row) { fail("catalog capability has no matrix row: " + capability); continue; }
  const expected = [...probes].sort();
  const actual = [...(row.probes ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(capability + ": row probes " + JSON.stringify(actual) + " != catalog " + JSON.stringify(expected));
  }
}
for (const [capability, skipped] of capabilityToSkipped) {
  const row = rowById.get(capability);
  if (!row) continue;
  const expected = [...skipped].sort();
  const actual = [...(row.skippedProbes ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(capability + ": row skippedProbes " + JSON.stringify(actual) + " != catalog " + JSON.stringify(expected));
  }
}
for (const row of matrix.capabilities ?? []) {
  for (const probeId of [...(row.probes ?? []), ...(row.skippedProbes ?? [])]) {
    if (!catalog.probes.some((probe) => probe.id === probeId)) {
      fail(row.id + ": lists unknown probe " + probeId);
    }
  }
}

// A differential run must cover the whole differential-eligible catalog; a
// partial/stale file is not evidence for any row.
const catalogDifferentialProbes = catalog.probes
  .filter((probe) => probe.differential !== false)
  .map((probe) => probe.id)
  .sort();
for (const [oracle, result] of Object.entries(differential)) {
  if (!result) continue;
  const covered = [...(result.probes ?? [])].sort();
  if (JSON.stringify(covered) !== JSON.stringify(catalogDifferentialProbes)) {
    fail("differential-" + oracle + ".json covers " + covered.length + "/" + catalogDifferentialProbes.length + " catalog probes — stale or partial result");
  }
}

// Evidence flags must match what the result files actually contain.
const resolved = [];
for (const row of matrix.capabilities ?? []) {
  const evidence = { ...row.evidence };
  for (const oracle of ["pinned", "latest", "hosted"]) {
    const flag = oracle + "_differential";
    const result = differential[oracle];
    const covered =
      result &&
      (row.probes ?? []).length > 0 &&
      row.probes.every(
        (probe) => result.probes.includes(probe) && !result.differences?.[probe],
      );
    if (evidence[flag] && !covered) {
      fail(row.id + ": claims " + flag + " but differential-" + oracle + " did not pass cleanly for " + JSON.stringify(row.probes ?? []));
    }
    if (!evidence[flag] && covered && result.pass) {
      fail(row.id + ": " + flag + " is supported by results but the flag is not set");
    }
  }
  if (strict && !differential.pinned) fail("differential-pinned.json missing");
  resolved.push(row);
}

const resolvedMatrix = {
  formatVersion: matrix.formatVersion,
  generatedAt: new Date().toISOString(),
  upstream: {
    pinned: driftPinned?.versions ?? {
      wrangler: manifest.wrangler,
      workersTypes: manifest.workersTypes,
      workerd: manifest.workerd,
    },
    latest: driftLatest?.versions ?? null,
  },
  verifiedAt: {
    pinned: differential.pinned?.checkedAt ?? null,
    latest: differential.latest?.checkedAt ?? null,
    hosted: differential.hosted?.checkedAt ?? null,
  },
  capabilities: resolved,
};
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "capabilities.json"), JSON.stringify(resolvedMatrix, null, 2) + "\n");

if (errors.length) {
  console.error("capability matrix violations:");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}
console.log("capability matrix OK: " + resolved.length + " capabilities, " + catalog.probes.length + " catalog probes");
