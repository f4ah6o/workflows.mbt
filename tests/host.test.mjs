import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectConfig } from "../host/config.mjs";
import { parseDuration, parseSleepUntil } from "../host/duration.mjs";
import {
  decodeDurableValue,
  encodeDurableValue,
  SerializationError,
} from "../host/serialization.mjs";

test("duration compatibility accepts numbers and Cloudflare-style units", () => {
  assert.equal(parseDuration(5000), 5000);
  assert.equal(parseDuration("5 seconds"), 5000);
  assert.equal(parseDuration("1 hour"), 3_600_000);
  assert.equal(parseSleepUntil(new Date(1234)), 1234);
  assert.equal(parseSleepUntil(5678), 5678);
});

test("durable JSON rejects unsupported nested values but preserves top-level undefined", () => {
  const encoded = encodeDurableValue({ hello: ["world", 1, true] });
  assert.deepEqual(decodeDurableValue(encoded), { hello: ["world", 1, true] });
  assert.equal(decodeDurableValue(encodeDurableValue(undefined)), undefined);
  assert.throws(
    () => encodeDurableValue({ bad: 1n }),
    (error) => error instanceof SerializationError,
  );
});

test("wrangler jsonc is consumed without rewriting unknown Cloudflare fields", () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-mbt-config-"));
  const path = join(root, "wrangler.jsonc");
  writeFileSync(
    path,
    `{
      // existing Cloudflare config stays intact
      "name": "x",
      "main": "src/index.ts",
      "compatibility_date": "2026-09-26",
      "workflows": [{
        "name": "wf",
        "binding": "WF",
        "class_name": "Workflow"
      }],
      "r2_buckets": [{ "binding": "R2", "bucket_name": "ignored" }],
    }`,
  );
  const config = loadProjectConfig(path);
  assert.equal(config.workflows[0].binding, "WF");
  assert.deepEqual(config.ignoredWranglerFields, ["r2_buckets"]);
  assert.equal(config.storagePath, join(root, ".workflows/workflows.db"));
});
