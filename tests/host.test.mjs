import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectConfig } from "../host/config.mjs";
import { matchesCron } from "../host/cron.mjs";
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

test("durable structured values round-trip with type preservation", () => {
  const bytes = new Uint8Array([1, 2, 3, 255]);
  const value = {
    date: new Date("2026-09-26T00:00:00.000Z"),
    buffer: bytes.buffer,
    typed: new Uint16Array([7, 1024]),
    map: new Map([["answer", 42], [{ nested: true }, new Set(["a", "b"])]]),
    bigint: 9007199254740993n,
    regexp: /workflow/gi,
    error: Object.assign(new TypeError("bad value"), { code: "E_TEST" }),
    undef: undefined,
  };
  const decoded = decodeDurableValue(encodeDurableValue(value));
  assert.ok(decoded.date instanceof Date);
  assert.equal(decoded.date.toISOString(), value.date.toISOString());
  assert.deepEqual([...new Uint8Array(decoded.buffer)], [1, 2, 3, 255]);
  assert.ok(decoded.typed instanceof Uint16Array);
  assert.deepEqual([...decoded.typed], [7, 1024]);
  assert.ok(decoded.map instanceof Map);
  assert.equal(decoded.map.get("answer"), 42);
  const objectKey = [...decoded.map.keys()].find((key) => typeof key === "object");
  assert.deepEqual(objectKey, { nested: true });
  assert.deepEqual([...decoded.map.get(objectKey)], ["a", "b"]);
  assert.equal(decoded.bigint, 9007199254740993n);
  assert.ok(decoded.regexp instanceof RegExp);
  assert.equal(decoded.regexp.source, "workflow");
  assert.ok(decoded.error instanceof Error);
  assert.equal(decoded.error.name, "TypeError");
  assert.equal(decoded.error.code, "E_TEST");
  assert.equal(decoded.undef, undefined);
  assert.equal(decodeDurableValue(encodeDurableValue(undefined)), undefined);
});

test("durable structured values reject cycles, functions, and streams explicitly", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeDurableValue(cyclic), SerializationError);
  assert.throws(() => encodeDurableValue({ bad() {} }), SerializationError);
  if (typeof ReadableStream !== "undefined") {
    assert.throws(
      () => encodeDurableValue(new ReadableStream()),
      /ReadableStream.*not yet supported/,
    );
  }
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


test("cron matcher uses UTC five-field workflow schedules", () => {
  const date = Date.UTC(2026, 8, 26, 5, 30);
  assert.equal(matchesCron("30 5 * * *", date), true);
  assert.equal(matchesCron("*/15 5 * * *", date), true);
  assert.equal(matchesCron("31 5 * * *", date), false);
  assert.equal(matchesCron("30 5 * * 6", date), true);
  assert.equal(matchesCron("30 5 * * SAT", date), true);
  assert.equal(matchesCron("30 5 * SEP MON-FRI", date), false);
  assert.equal(
    matchesCron("0 9 * * MON-FRI", Date.UTC(2026, 8, 25, 9, 0)),
    true,
  );
  assert.equal(
    matchesCron("0 9 * * MON-FRI", Date.UTC(2026, 8, 26, 9, 0)),
    false,
  );
  assert.equal(
    matchesCron("0 9 1 JAN,MAR *", Date.UTC(2026, 2, 1, 9, 0)),
    true,
  );
});


test("Wrangler vars and .dev.vars secrets are available to workflow env", () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-mbt-env-"));
  const path = join(root, "wrangler.jsonc");
  writeFileSync(
    path,
    JSON.stringify({
      name: "env-test",
      main: "src/index.ts",
      vars: {
        API_HOST: "example.test",
        STRUCTURED: { enabled: true },
      },
      secrets: { required: ["SECRET_KEY"] },
      workflows: [{
        name: "wf",
        binding: "WF",
        class_name: "Workflow",
      }],
    }),
  );
  writeFileSync(
    join(root, ".dev.vars"),
    'SECRET_KEY="secret-value"\nIGNORED_SECRET="not-loaded"\n',
  );
  const config = loadProjectConfig(path);
  assert.deepEqual(config.vars, {
    API_HOST: "example.test",
    STRUCTURED: { enabled: true },
  });
  assert.deepEqual(config.localDevEnv, { SECRET_KEY: "secret-value" });
  assert.deepEqual(config.ignoredWranglerFields, []);
});
