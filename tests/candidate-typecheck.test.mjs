import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedTypes = join(root, "node_modules/@cloudflare/workers-types");
const pinnedVersion = JSON.parse(readFileSync(join(pinnedTypes, "package.json"), "utf8")).version;

// Fixture candidates are isolated and never resolved from the network. Extend
// the installed pinned declarations so this regression also runs in pinned CI.
function runTypecheck(t, { latest = false, wrongCount = false, removeMessageBatch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wf-candidate-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const typesRoot = join(dir, "candidate-types");
  mkdirSync(join(typesRoot, "experimental"), { recursive: true });
  let source = readFileSync(join(pinnedTypes, "experimental/index.d.ts"), "utf8");
  if (latest) {
    const legacy = "  public createBatch(\n    batch: WorkflowInstanceCreateOptions<PARAMS>[],";
    assert.ok(source.includes(legacy), "pinned Workflow array signature is the fixture anchor");
    source = source.replace(legacy, `  public createBatch(\n    options: WorkflowBatchCreateOptions<PARAMS>,\n  ): Promise<WorkflowBatchCreateResult>;\n${legacy}`);
    source += `\ntype WorkflowBatchCreateOptions<PARAMS = unknown> =
      | { count: ${wrongCount ? "string" : "number"}; params?: PARAMS;
          retention?: WorkflowInstanceCreateOptions<PARAMS>["retention"];
          locationHint?: WorkflowInstanceLocationHint; instances?: never; }
      | { instances: WorkflowInstanceCreateOptions<PARAMS>[]; count?: never;
          params?: never; retention?: never; locationHint?: never; };
      type WorkflowBatchCreateResult = { created: WorkflowInstance[];
        errors: { index: number; id?: string; code: number; message: string }[]; };\n`;
  }
  if (removeMessageBatch) {
    const declaration = "interface MessageBatch<Body = unknown>";
    assert.ok(source.includes(declaration));
    source = source.replace(declaration, "interface CandidateOnlyMessageBatch<Body = unknown>");
  }
  writeFileSync(join(typesRoot, "index.d.ts"), source);
  writeFileSync(join(typesRoot, "experimental/index.d.ts"), source);
  const oracle = latest ? "latest" : "pinned";
  const candidate = {
    formatVersion: 1, status: "ok", mode: oracle,
    id: "synthetic-typecheck-" + oracle,
    resolvedAt: "2026-10-04T00:00:00.000Z",
    versions: { workersTypes: latest ? "5.20261002.1" : pinnedVersion },
    paths: {
      cfBin: join(root, "node_modules/.bin/cf"),
      wranglerBin: join(root, "node_modules/.bin/wrangler"),
      typesPath: join(typesRoot, "index.d.ts"),
      schemaPath: join(root, "node_modules/wrangler/config-schema.json"),
      workersTypesPkg: typesRoot,
    },
  };
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(candidatePath, JSON.stringify(candidate));
  const proc = spawnSync(process.execPath, [join(root, "compat/run-typecheck.mjs"), "--oracle", oracle, "--candidate", candidatePath], {
    cwd: root,
    env: { ...process.env, WORKFLOWS_MBT_RESULTS_DIR: join(dir, "results") },
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(proc.error, undefined, proc.error?.message);
  const config = JSON.parse(readFileSync(join(dir, "results", `tsconfig-${oracle}.json`), "utf8"));
  const result = JSON.parse(readFileSync(join(dir, "results", `typecheck-${oracle}.json`), "utf8"));
  assert.deepEqual(config.compilerOptions.types, [join(typesRoot, "experimental")]);
  assert.deepEqual(config.compilerOptions.paths["cloudflare:workers"], [join(root, "compat/cloudflare-workers/types.d.ts")]);
  assert.equal(config.files.includes(join(root, "compat/typecheck/batch-create-upstream.ts")), latest);
  assert.equal(result.candidateId, candidate.id);
  return { proc, config, result };
}

test("candidate typecheck uses isolated pinned ambient declarations and excludes the newer fixture", (t) => {
  const { proc, result } = runTypecheck(t);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  assert.equal(result.pass, true);
});

test("candidate typecheck includes object-batch calls against the selected newer declarations", (t) => {
  const { proc, result } = runTypecheck(t, { latest: true });
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  assert.equal(result.pass, true);
});

test("candidate typecheck cannot silently fall back to repository-pinned global declarations", (t) => {
  const { proc, result } = runTypecheck(t, { removeMessageBatch: true });
  assert.equal(proc.status, 1);
  assert.equal(result.pass, false);
  assert.ok(result.diagnostics.some((line) => line.includes("Cannot find name 'MessageBatch'")), proc.stdout + proc.stderr);
});

test("candidate batch signature drift is diagnosed by the real upstream fixture", (t) => {
  const { proc, result } = runTypecheck(t, { latest: true, wrongCount: true });
  assert.equal(proc.status, 1);
  assert.equal(result.pass, false);
  assert.ok(result.diagnostics.some((line) => line.includes("batch-create-upstream.ts") && line.includes("Type 'number' is not assignable to type 'string'")), proc.stdout + proc.stderr);
});
