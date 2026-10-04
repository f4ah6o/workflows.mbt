import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectConfig } from "../host/config.mjs";
import { WorkerExecutionContext, resolveTracingScope } from "../host/execution-context.mjs";
import { observeTracingScope } from "./fixtures/tracing-scope.mjs";

const makeContext = (scope) => new WorkerExecutionContext({ config: { tracingScope: scope } });
const expectedMethod = {
  syncReturn: 7,
  syncActive: true,
  afterSync: true,
  asyncReturn: "returned",
  distinctFromRoot: true,
  beforeAwait: true,
  afterAwait: true,
  nested: true,
  afterNested: true,
  afterAsync: true,
  sameThrownError: true,
  afterThrow: true,
  sameRejectedError: true,
  afterRejection: true,
  concurrent: [true, true],
  afterConcurrent: true,
};

for (const scope of ["callback", "invocation"]) {
  test(`tracing ${scope} scope restores its parent through await, nesting, errors and concurrency`, async () => {
    assert.deepEqual(await observeTracingScope(makeContext(scope).tracing), {
      ambientPresent: scope === "invocation",
      ambientStable: true,
      detachedPreservesActive: true,
      methods: { enterSpan: expectedMethod, startActiveSpan: expectedMethod },
      afterAll: true,
    });
  });

  test(`tracing ${scope} contexts do not share active spans`, async () => {
    const first = makeContext(scope).tracing;
    const second = makeContext(scope).tracing;
    const otherRoot = second.getActiveSpan();
    if (scope === "invocation") assert.notEqual(first.getActiveSpan(), otherRoot);
    await first.enterSpan("first", async (span) => {
      assert.notEqual(span, otherRoot);
      assert.equal(second.getActiveSpan(), otherRoot);
      await second.startActiveSpan("second", async (other) => {
        await Promise.resolve();
        assert.equal(first.getActiveSpan(), span);
        assert.equal(second.getActiveSpan(), other);
      });
      assert.equal(second.getActiveSpan(), otherRoot);
    });
  });

  test(`tracing ${scope} auto-end does not call patched public end`, async () => {
    const tracing = makeContext(scope).tracing;
    let ended = 0;
    for (const method of ["enterSpan", "startActiveSpan"]) {
      await tracing[method]("span", async (span) => {
        span.end = () => { ended += 1; };
        await Promise.resolve();
      });
      assert.equal(ended, 0);
    }
  });
}

test("tracing defaults to pinned callback-only behavior and rejects unknown policies", () => {
  assert.equal(resolveTracingScope(), "callback");
  assert.equal(makeContext().tracing.getActiveSpan(), undefined);
  for (const invalid of [null, true, "latest", "", "auto"]) {
    assert.throws(() => resolveTracingScope(invalid), /tracingScope/);
    assert.throws(() => makeContext(invalid), /tracingScope/);
  }
});

test("local tracing policy is explicit, validated, and overridden by the runtime option", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflows-tracing-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify({ main: "index.ts", workflows: [{ name: "trace", binding: "TRACE", class_name: "Trace" }] }));
  const localPath = join(root, "workflows.mbt.json");
  assert.equal(loadProjectConfig(configPath).tracingScope, "callback");
  writeFileSync(localPath, JSON.stringify({ compatibility: { tracingScope: "invocation" } }));
  assert.equal(loadProjectConfig(configPath).tracingScope, "invocation");
  assert.equal(loadProjectConfig(configPath, { tracingScope: "callback" }).tracingScope, "callback");
  writeFileSync(localPath, JSON.stringify({ compatibility: { tracingScope: "unknown" } }));
  assert.throws(() => loadProjectConfig(configPath), /tracingScope/);
});
