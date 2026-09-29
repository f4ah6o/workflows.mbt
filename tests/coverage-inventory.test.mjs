// Hermetic tests for the coverage foundation (issue 20260929 phases 1–3):
// the reduction/state model, inventory extraction over fixture upstream
// sources, and the check-inventory / check-capabilities validators run
// against throwaway results dirs via WORKFLOWS_MBT_RESULTS_DIR.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildResultFingerprint,
  candidateIdentity,
  computeRelevantInputs,
  dependencyGraphHash,
  evidenceIsStale,
  reduceProbeVerdicts,
} from "../compat/coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dir() {
  return mkdtempSync(join(tmpdir(), "wfmbt-inv-"));
}

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120000,
  });
}

// ── Phase 1: state reduction + fingerprint model ────────────────────────────

test("reduceProbeVerdicts is first-match and deterministic", () => {
  assert.equal(reduceProbeVerdicts([]), "UNTESTED");
  assert.equal(reduceProbeVerdicts(["VERIFIED", "VERIFIED"]), "VERIFIED");
  assert.equal(reduceProbeVerdicts(["VERIFIED", "DIVERGENT"]), "DIVERGENT");
  assert.equal(reduceProbeVerdicts(["UNTESTED", "BLOCKED", "VERIFIED"]), "BLOCKED");
  assert.equal(reduceProbeVerdicts(["UNTESTED", "STALE", "VERIFIED"]), "STALE");
  assert.equal(reduceProbeVerdicts(["STALE", "DIVERGENT"]), "DIVERGENT");
  assert.equal(reduceProbeVerdicts(["VERIFIED"], { declaredUnsupported: true }), "UNSUPPORTED");
  assert.equal(reduceProbeVerdicts([], { declaredUnsupported: true }), "UNSUPPORTED");
});

test("candidate identity includes the dependency graph hash", () => {
  const candidate = {
    id: "pinned-abc",
    versions: { wrangler: "1.0.0" },
    dependencyGraph: { workerd: "1.0.0", miniflare: "2.0.0" },
  };
  const identity = candidateIdentity(candidate);
  assert.equal(identity.id, "pinned-abc");
  assert.ok(identity.dependencyGraphHash.startsWith("sha256:"));
  const changed = dependencyGraphHash({ dependencyGraph: { workerd: "1.0.1", miniflare: "2.0.0" } });
  assert.notEqual(changed, identity.dependencyGraphHash);
});

test("evidence freshness keys on relevant inputs, not commit", () => {
  const candidate = { id: "c1", versions: {}, dependencyGraph: {}, conditions: {} };
  const inputs = computeRelevantInputs(root, candidate);
  const a = buildResultFingerprint({ runId: "r1", oracle: "pinned", candidate, relevantInputs: inputs, commit: "aaa" });
  const b = buildResultFingerprint({ runId: "r2", oracle: "pinned", candidate, relevantInputs: inputs, commit: "bbb" });
  assert.notEqual(a.commit, b.commit);
  assert.equal(evidenceIsStale(a.relevantInputs, b.relevantInputs), false);
  const tampered = { ...b.relevantInputs, catalogHash: "sha256:0" };
  assert.equal(evidenceIsStale(a.relevantInputs, tampered), true);
});

// ── Phase 2: extraction over fixture upstream sources ───────────────────────

const FIXTURE_TYPES = `
declare module "cloudflare:workers" {
  export = CfwModule;
}
declare namespace CfwModule {
  export interface WorkflowStep {
    do(name: string, callback: () => Promise<StepOutput>): Promise<StepOutput>;
    sleep(duration: WorkflowSleepDuration): Promise<void>;
  }
  export type WorkflowSleepDuration = number | DurationLabel;
  export class WorkflowEntrypoint {
    ctx: ExecutionContext;
    env: unknown;
  }
}
declare class Workflow {
  get(id: string): WorkflowHandle;
}
interface StepOutput {
  value: string;
}
interface WorkflowHandle {
  status(): Promise<string>;
}
interface DurationLabel {}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
declare class IgnoredThing {
  noise(): void;
}
`;

const FIXTURE_SCHEMA = JSON.stringify({
  definitions: {
    RawConfig: {
      type: "object",
      properties: {
        workflows: { $ref: "#/definitions/WorkflowBinding" },
        name: { type: "string" },
        unrelated: { type: "string" },
      },
    },
    WorkflowBinding: {
      type: "object",
      properties: {
        binding: { type: "string" },
        class_name: { type: "string" },
      },
    },
  },
  allOf: [{ $ref: "#/definitions/RawConfig" }],
});

const FIXTURE_SPEC = {
  formatVersion: 1,
  profiles: {
    core: { lifecycle: "active", description: "workflow engine surface" },
    host: { lifecycle: "active", description: "worker host surface" },
    platform: { lifecycle: "deferred", description: "rest of workers-types" },
  },
  profileOrder: ["core", "host", "platform"],
  roots: {
    core: { workersTypes: [{ container: "cloudflare:workers", names: ["Workflow*"] }] },
    host: { workersTypes: [{ container: "global", names: ["Workflow", "StepOutput"] }], wranglerSchema: ["workflows"] },
    platform: { workersTypes: [], wranglerSchema: [] },
  },
};

function seedFixtureInventory(dirPath) {
  const inv = join(dirPath, "inventory");
  mkdirSync(inv, { recursive: true });
  writeFileSync(join(inv, "discovery-roots.json"), JSON.stringify(FIXTURE_SPEC));
  writeFileSync(join(dirPath, "types.d.ts"), FIXTURE_TYPES);
  writeFileSync(join(dirPath, "schema.json"), FIXTURE_SCHEMA);
  return inv;
}

function runExtract(dirPath, args = []) {
  return run("compat/inventory/extract.mjs", [
    "--types", join(dirPath, "types.d.ts"),
    "--schema", join(dirPath, "schema.json"),
    "--out", join(dirPath, "out.json"),
    ...args,
  ], { WORKFLOWS_MBT_INVENTORY_DIR: join(dirPath, "inventory") });
}

test("extract.mjs produces stable ids, member items, and reference closure", () => {
  const dirPath = dir();
  seedFixtureInventory(dirPath);
  const result = runExtract(dirPath);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(readFileSync(join(dirPath, "out.json"), "utf8"));
  const byId = new Map(out.api.map((item) => [item.id, item]));

  const stepDo = byId.get("cloudflare:workers.WorkflowStep.do");
  assert.ok(stepDo, "member item for WorkflowStep.do");
  assert.equal(stepDo.kind, "member");
  assert.equal(stepDo.matchedBy, "core");
  assert.ok(stepDo.contract.fingerprint.startsWith("fnv1a:"));

  // union type → variant items
  assert.ok(byId.has("cloudflare:workers.WorkflowSleepDuration.variant-0")
    || byId.has("cloudflare:workers.WorkflowSleepDuration.variant-1"), "union variants present");

  // transitive reference closure: DurationLabel is not root-matched but is
  // referenced by the WorkflowSleepDuration union
  const label = byId.get("global.DurationLabel");
  assert.ok(label, "referenced type discovered");
  assert.equal(label.kind, "referenced-type");
  assert.equal(label.matchedBy, null);
  assert.ok(label.via.includes("cloudflare:workers.WorkflowSleepDuration"));

  // host-root declaration + its referenced WorkflowHandle
  assert.ok(byId.get("global.Workflow")?.matchedBy === "host");
  const handle = byId.get("global.WorkflowHandle");
  assert.equal(handle?.kind, "referenced-type");
  assert.ok(handle?.via.includes("global.Workflow"));

  // unmatched + unreferenced declarations are deferred to the deferred profile
  const deferred = new Map((out.deferred ?? []).map((item) => [item.id, item]));
  assert.ok(deferred.has("global.IgnoredThing"), "unmatched declarations land in deferred");

  // wrangler schema walk
  const cfgIds = new Set(out.config.map((item) => item.id));
  assert.ok(cfgIds.has("wrangler.workflows"));
  assert.ok(cfgIds.has("wrangler.workflows.binding"));
  assert.ok(!cfgIds.has("wrangler.unrelated"), "unrooted config key not extracted");
});

test("extract.mjs rejects overlapping profile roots", () => {
  const dirPath = dir();
  const inv = seedFixtureInventory(dirPath);
  const spec = structuredClone(FIXTURE_SPEC);
  spec.roots.host.workersTypes.push({ container: "cloudflare:workers", names: ["Workflow*"] });
  writeFileSync(join(inv, "discovery-roots.json"), JSON.stringify(spec));
  const result = runExtract(dirPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlap|claimed/i);
});

// ── Phase 2: check-inventory validators ─────────────────────────────────────

test("check-inventory passes on the committed baselines", () => {
  const resultsDir = dir();
  const result = run("compat/check-inventory.mjs", [], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir });
  assert.equal(result.status, 0, result.stderr);
  const check = JSON.parse(readFileSync(join(resultsDir, "inventory-check.json"), "utf8"));
  assert.equal(check.pass, true);
  assert.equal(check.classificationCoverage.discovered, check.classificationCoverage.classified);
});

test("check-inventory --verify detects baseline drift", () => {
  const dirPath = dir();
  seedFixtureInventory(dirPath);
  // Committed baselines + classification vs a fixture upstream that does not
  // produce them — verification must report added and missing items.
  const inv = join(dirPath, "inventory");
  for (const name of ["upstream-api.json", "upstream-config.json", "semantic.json", "classification.json"]) {
    writeFileSync(join(inv, name), readFileSync(join(root, "compat/inventory", name)));
  }
  const resultsDir = join(dirPath, "results");
  const result = run("compat/check-inventory.mjs", [
    "--verify", "--types", join(dirPath, "types.d.ts"), "--schema", join(dirPath, "schema.json"),
  ], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir, WORKFLOWS_MBT_INVENTORY_DIR: inv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not in baseline|no longer produced|fingerprint drift/);
});

test("check-inventory fails on unclassified baseline items", () => {
  const dirPath = dir();
  const inv = join(dirPath, "inventory");
  mkdirSync(inv, { recursive: true });
  for (const name of ["discovery-roots.json", "upstream-api.json", "upstream-config.json", "semantic.json"]) {
    writeFileSync(join(inv, name), readFileSync(join(root, "compat/inventory", name)));
  }
  writeFileSync(join(inv, "classification.json"), JSON.stringify({ formatVersion: 1, items: {} }));
  const result = run("compat/check-inventory.mjs", [], {
    WORKFLOWS_MBT_INVENTORY_DIR: inv,
    WORKFLOWS_MBT_RESULTS_DIR: join(dirPath, "results"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unclassified/);
});

// ── Phase 3: check-capabilities chain validation ────────────────────────────

test("check-capabilities passes with no result files (notes only)", () => {
  const resultsDir = dir();
  const result = run("compat/check-capabilities.mjs", [], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir });
  assert.equal(result.status, 0, result.stderr);
});

test("check-capabilities fails when a required oracle result is missing", () => {
  const resultsDir = dir();
  const result = run("compat/check-capabilities.mjs", ["--require-pinned"], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differential-pinned\.json missing/);
});

test("check-capabilities fails on a partial differential result", () => {
  const resultsDir = dir();
  writeFileSync(join(resultsDir, "differential-pinned.json"), JSON.stringify({ probes: ["basic"], pass: true }));
  const result = run("compat/check-capabilities.mjs", [], { WORKFLOWS_MBT_RESULTS_DIR: resultsDir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale or partial result/);
});

test("check-capabilities fails on a broken capability→requirement chain", () => {
  const resultsDir = dir();
  const matrix = JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));
  matrix.capabilities[0].requirements = ["req.workflows-core.nonexistent.requirement"];
  const badMatrix = join(resultsDir, "bad-capabilities.json");
  writeFileSync(badMatrix, JSON.stringify(matrix));
  const result = run("compat/check-capabilities.mjs", [], {
    WORKFLOWS_MBT_RESULTS_DIR: resultsDir,
    WORKFLOWS_MBT_CAPABILITIES: badMatrix,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown requirement/);
});

test("check-capabilities fails on a profile-mismatched upstream ref", () => {
  const resultsDir = dir();
  const matrix = JSON.parse(readFileSync(join(root, "compat/capabilities.json"), "utf8"));
  const row = matrix.capabilities.find((capability) => capability.id === "step.do");
  row.upstream.symbols.push("global.WorkflowInstance.pause"); // workflow-host item on a workflows-core capability
  const badMatrix = join(resultsDir, "bad-capabilities.json");
  writeFileSync(badMatrix, JSON.stringify(matrix));
  const result = run("compat/check-capabilities.mjs", [], {
    WORKFLOWS_MBT_RESULTS_DIR: resultsDir,
    WORKFLOWS_MBT_CAPABILITIES: badMatrix,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /classifies to profile workflow-host/);
});
