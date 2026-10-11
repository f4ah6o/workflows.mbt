import assert from "node:assert/strict";
import test from "node:test";
import { differentialProbes, tracingScopeFor } from "../compat/candidate-policy.mjs";
const catalog = { probes: [{ id: "legacy" }, { id: "batch", minimumWorkersTypes: "5.20261002.1" }, { id: "skipped", differential: false }] };
const candidate = (workersTypes, vitePlugin) => ({ versions: { workersTypes, vitePlugin } });
test("batch probe is candidate-bound and never waived without candidate evidence", () => {
  assert.deepEqual(differentialProbes(catalog, candidate("5.20260925.2")), ["legacy"]);
  assert.deepEqual(differentialProbes(catalog, candidate("5.20261002.1")), ["legacy", "batch"]);
  assert.deepEqual(differentialProbes(catalog, candidate("5.20261004.1")), ["legacy", "batch"]);
  assert.deepEqual(differentialProbes(catalog, null), ["legacy", "batch"]);
  assert.throws(() => differentialProbes(catalog, candidate("latest")), /Invalid/);
});
test("only observed oracle plugin versions opt into invocation tracing", () => {
  assert.equal(tracingScopeFor(candidate(null, "1.62.0")), "callback");
  assert.equal(tracingScopeFor(candidate(null, "1.62.4")), "invocation");
  assert.equal(tracingScopeFor(candidate(null, "1.62.5")), "invocation");
  assert.equal(tracingScopeFor(candidate(null, "1.63.0")), "callback");
  assert.equal(tracingScopeFor(candidate(null, "1.63.1")), "invocation");
  assert.equal(tracingScopeFor(null), "callback");
});
