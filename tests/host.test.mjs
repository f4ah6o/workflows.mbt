import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "../host/config.mjs";
import { WorkflowRuntime } from "../host/engine.mjs";
import { runDoctor } from "../host/doctor.mjs";
import { loadLocalDevEnv } from "../host/env.mjs";
import { connectSocket } from "../host/socket.mjs";
import { matchesCron } from "../host/cron.mjs";
import { parseDuration, parseSleepUntil } from "../host/duration.mjs";
import {
  decodeDurableValue,
  encodeDurableValue,
  normalizeDurableValue,
  SerializationError,
} from "../host/serialization.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  // Upstream's structured-clone boundary drops error own-properties and
  // keeps `name` non-enumerable, so a revived Error stringifies to "{}".
  assert.equal(decoded.error.code, undefined);
  assert.equal(JSON.stringify(decoded.error), "{}");
  assert.equal(Object.keys(decoded.error).length, 0);
  assert.equal(decoded.undef, undefined);
  assert.equal(decodeDurableValue(encodeDurableValue(undefined)), undefined);
});

test("durable structured values reject cyclic graphs like upstream", () => {
  // The upstream serialize boundary fails cyclic step output with a
  // catchable TypeError; acyclic repeated references still encode.
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  assert.throws(() => encodeDurableValue(cyclic), TypeError);

  const map = new Map();
  map.set("self", map);
  assert.throws(() => encodeDurableValue({ map }), TypeError);

  const array = [];
  array.push(array);
  assert.throws(() => encodeDurableValue(array), TypeError);

  // A DAG (shared but acyclic) encodes each occurrence independently.
  const shared = { answer: 42 };
  const decoded = decodeDurableValue(
    encodeDurableValue({ first: shared, second: shared }),
  );
  assert.deepEqual(decoded.first, { answer: 42 });
  assert.deepEqual(decoded.second, { answer: 42 });
});

test("durable structured values reject functions and streams explicitly", () => {
  assert.throws(() => encodeDurableValue({ bad() {} }), SerializationError);
  assert.throws(
    () => encodeDurableValue({ sym: Symbol("nope") }),
    SerializationError,
  );
  if (typeof ReadableStream !== "undefined") {
    assert.throws(
      () => encodeDurableValue(new ReadableStream()),
      /ReadableStream.*persist step streams through the runtime/,
    );
  }
});

test("durable structured values round-trip Headers, Request, Response, and Blob", async () => {
  const headers = new Headers({ "x-one": "a" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const value = {
    headers,
    request: new Request("https://example.test/submit?x=1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "payload-bytes",
    }),
    response: new Response("body-bytes", {
      status: 418,
      statusText: "teapot",
      headers: { "x-res": "yes" },
    }),
    blob: new Blob(["blob-bytes"], { type: "text/plain" }),
    sharedHeaders: headers,
  };
  const encoded = encodeDurableValue(
    value,
    "value",
    await normalizeDurableValue(value, "value"),
  );
  const decoded = decodeDurableValue(encoded);

  assert.ok(decoded.sharedHeaders instanceof Headers);
  assert.deepEqual(
    decoded.headers.get("set-cookie")?.split(", "),
    ["a=1", "b=2"],
  );
  assert.ok(decoded.request instanceof Request);
  assert.equal(decoded.request.method, "POST");
  assert.equal(decoded.request.url, "https://example.test/submit?x=1");
  assert.equal(await decoded.request.text(), "payload-bytes");
  assert.ok(decoded.response instanceof Response);
  assert.equal(decoded.response.status, 418);
  assert.equal(await decoded.response.text(), "body-bytes");
  assert.ok(decoded.blob instanceof Blob);
  assert.equal(decoded.blob.type, "text/plain");
  assert.equal(await decoded.blob.text(), "blob-bytes");

  // Nested streams inside a structured result still fail loudly.
  await assert.rejects(
    normalizeDurableValue({ nested: new ReadableStream() }, "value"),
    /only top-level ReadableStream<Uint8Array> step results/,
  );
  // Consumed bodies cannot be persisted.
  const consumed = new Request("https://example.test", {
    method: "POST",
    body: "x",
    duplex: "half",
  });
  await consumed.text();
  await assert.rejects(
    normalizeDurableValue({ consumed }, "value"),
    /already consumed/,
  );

  // Without the async normalization pass, these composite values error
  // explicitly rather than serializing lossy shapes.
  assert.throws(
    () => encodeDurableValue({ blob: new Blob(["x"]) }),
    SerializationError,
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
      "r2_buckets": [{ "binding": "R2", "bucket_name": "assets" }],
      "placement": { "mode": "smart" },
    }`,
  );
  const config = loadProjectConfig(path);
  assert.equal(config.workflows[0].binding, "WF");
  assert.deepEqual(config.r2Buckets, [{ binding: "R2", bucket_name: "assets" }]);
  assert.deepEqual(config.ignoredWranglerFields, ["placement"]);
  assert.equal(config.storagePath, join(root, ".workflows/workflows.db"));
});


test("cloudflare.config.ts is the primary config and resolves Workflow exports/bindings", () => {
  const config = loadProjectConfig(
    join(repoRoot, "fixtures/cloudflare-basic/cloudflare.config.ts"),
  );
  assert.equal(config.configFormat, "cloudflare");
  assert.equal(config.name, "cloudflare-basic");
  assert.equal(config.main, join(repoRoot, "fixtures/cloudflare-basic/src/index.ts"));
  assert.equal(config.compatibilityDate, "2026-09-26");
  assert.deepEqual(config.workflows, [{
    name: "my-workflow",
    binding: "MY_WORKFLOW",
    bindings: ["MY_WORKFLOW"],
    className: "MyWorkflow",
    schedules: [],
    defaultRetention: null,
  }]);
});

test("cloudflare config logs do not corrupt config loading or doctor JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-logged-config-"));
  try {
    writeFileSync(join(root, "logging.mjs"), `console.log("import log");
process.stdout.write("raw stdout log\\n");
console.error("import stderr");
`);
    writeFileSync(join(root, "index.ts"), "export class WF {}\n");
    const configPath = join(root, "cloudflare.config.ts");
    writeFileSync(configPath, `import "./logging.mjs";
import { bindings, defineConfig, exports } from "cf/config";
export default defineConfig((ctx) => {
  console.log("factory mode", ctx.mode);
  return { worker: {
    name: "logged-worker", entrypoint: "index.ts", compatibilityDate: "2026-09-26",
    env: { WF: bindings.workflow({ name: "logged-workflow", worker: "logged-worker", exportName: "WF" }) },
    exports: { WF: exports.workflow({ name: "logged-workflow" }) },
  } };
});
`);
    const config = loadProjectConfig(configPath, { modeName: "staging" });
    assert.equal(config.name, "logged-worker");
    assert.equal(config.workflows[0].name, "logged-workflow");
    const doctor = spawnSync(process.execPath, [
      join(repoRoot, "host/cli.mjs"), "doctor", "--config", configPath,
      "--mode", "staging", "--json",
    ], { encoding: "utf8" });
    assert.ifError(doctor.error);
    const report = JSON.parse(doctor.stdout);
    assert.ok(report.checks.some((check) => check.name === "config" && check.ok), doctor.stdout);
    assert.match(doctor.stderr, /import log/);
    assert.match(doctor.stderr, /raw stdout log/);
    assert.match(doctor.stderr, /factory mode staging/);
    assert.match(doctor.stderr, /import stderr/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloudflare.config.ts preserves multiple aliases for one Workflow identity", () => {
  const root = mkdtempSync(join(repoRoot, ".cf-alias-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.ts"), "export class WF {}\n");
    writeFileSync(
      join(root, "cloudflare.config.ts"),
      `import { bindings, defineConfig, exports } from "cf/config";
const workerName = "review";
export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",
    env: {
      FIRST: bindings.workflow({
        name: "review-wf",
        worker: workerName,
        exportName: "WF",
      }),
      SECOND: bindings.workflow({
        name: "review-wf",
        worker: workerName,
        exportName: "WF",
      }),
    },
    exports: {
      WF: exports.workflow({ name: "review-wf" }),
    },
  },
});
`,
    );

    const config = loadProjectConfig(join(root, "cloudflare.config.ts"));
    assert.equal(config.workflows.length, 1);
    assert.equal(config.workflows[0].name, "review-wf");
    assert.equal(config.workflows[0].className, "WF");
    assert.deepEqual(config.workflows[0].bindings, ["FIRST", "SECOND"]);

    const runtime = new WorkflowRuntime({
      config,
      kernel: {},
      storage: {},
      env: {},
    });
    runtime.adapters = {};
    const env = runtime.env();
    assert.equal(env.FIRST.workflow, config.workflows[0]);
    assert.equal(env.SECOND.workflow, config.workflows[0]);
    assert.equal(env.FIRST.workflow.name, env.SECOND.workflow.name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloudflare.config.ts resolves --mode through the official config loader", () => {
  const root = mkdtempSync(join(repoRoot, ".cf-config-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.ts"), "export class ModeWorkflow {}\n");
    writeFileSync(
      join(root, "cloudflare.config.ts"),
      `import { bindings, defineConfig, exports } from "cf/config";
const workflowName = "mode-workflow";
export default defineConfig((ctx) => {
  const workerName = ctx.mode === "staging" ? "mode-staging" : "mode-default";
  return {
    worker: {
      name: workerName,
      entrypoint: "src/index.ts",
      compatibilityDate: "2026-09-26",
      env: {
        MODE: bindings.text(ctx.mode ?? "default"),
        WF: bindings.workflow({
          name: workflowName,
          worker: workerName,
          exportName: "ModeWorkflow",
        }),
      },
      exports: {
        ModeWorkflow: exports.workflow({
          name: workflowName,
          defaultRetention: {
            successRetention: "3 days",
            errorRetention: "7 days",
          },
        }),
      },
    },
  };
});
`,
    );
    const config = loadProjectConfig(join(root, "cloudflare.config.ts"), {
      modeName: "staging",
    });
    assert.equal(config.modeName, "staging");
    assert.equal(config.name, "mode-staging");
    assert.deepEqual(config.vars, { MODE: "staging" });
    assert.equal(config.workflows[0].binding, "WF");
    assert.deepEqual(config.workflows[0].defaultRetention, {
      success_retention: "3 days",
      error_retention: "7 days",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cron matcher uses UTC five-field workflow schedules", () => {
  const saturday = Date.UTC(2026, 8, 26, 5, 30);
  assert.equal(matchesCron("30 5 * * *", saturday), true);
  assert.equal(matchesCron("*/15 5 * * *", saturday), true);
  assert.equal(matchesCron("31 5 * * *", saturday), false);
  assert.equal(matchesCron("30 5 * * SAT", saturday), true);
  assert.equal(matchesCron("30 5 * SEP MON-FRI", saturday), false);
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

test("cron numeric weekdays follow Cloudflare 1=SUN..7=SAT", () => {
  const sunday = Date.UTC(2026, 8, 27, 5, 30);
  const monday = Date.UTC(2026, 8, 28, 5, 30);
  const saturday = Date.UTC(2026, 8, 26, 5, 30);
  assert.equal(matchesCron("30 5 * * 1", sunday), true);
  assert.equal(matchesCron("30 5 * * 1", monday), false);
  assert.equal(matchesCron("30 5 * * 2", monday), true);
  assert.equal(matchesCron("30 5 * * 7", saturday), true);
  assert.equal(matchesCron("30 5 * * 6", saturday), false);
  assert.equal(matchesCron("30 5 * * 6", Date.UTC(2026, 8, 25, 5, 30)), true);

  // Cloudflare's documented MON-FRI range equals numeric 2-6.
  const weekdayDates = [
    Date.UTC(2026, 8, 27, 5, 30),
    Date.UTC(2026, 8, 28, 5, 30),
    Date.UTC(2026, 8, 29, 5, 30),
    Date.UTC(2026, 8, 30, 5, 30),
    Date.UTC(2026, 9, 1, 5, 30),
    Date.UTC(2026, 9, 2, 5, 30),
    Date.UTC(2026, 9, 3, 5, 30),
  ];
  assert.deepEqual(
    weekdayDates.map((date) => matchesCron("30 5 * * 2-6", date)),
    weekdayDates.map((date) => matchesCron("30 5 * * MON-FRI", date)),
  );

  // Cloudflare's five-field syntax has no numeric Sunday-as-zero alias.
  assert.throws(() => matchesCron("30 5 * * 0", sunday), /Invalid cron/);
  assert.throws(() => matchesCron("30 5 * * 0-6", sunday), /Invalid cron/);
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


test("wrangler env overlay treats non-inheritable keys per Wrangler", () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-mbt-env-overlay-"));
  const path = join(root, "wrangler.jsonc");
  writeFileSync(
    path,
    JSON.stringify({
      name: "overlay-test",
      main: "src/index.ts",
      vars: { BASE: "base", SHARED: "base-value" },
      secrets: { required: ["BASE_SECRET"] },
      workflows: [{
        name: "wf-base",
        binding: "WF_BASE",
        class_name: "Workflow",
      }],
      kv_namespaces: [{ binding: "KV_BASE" }],
      env: {
        staging: {
          vars: { SHARED: "staging-value", STAGED: "yes" },
          secrets: { required: ["STAGING_SECRET"] },
          workflows: [{
            name: "wf-staging",
            binding: "WF_STAGING",
            class_name: "StagingWorkflow",
          }],
        },
      },
    }),
  );
  writeFileSync(join(root, ".dev.vars"), 'BASE_SECRET="base"\nSHARED_SECRET="from-base"\n');
  writeFileSync(
    join(root, ".dev.vars.staging"),
    'STAGING_SECRET="staged"\nSHARED_SECRET="from-staging"\n',
  );

  const config = loadProjectConfig(path, { envName: "staging" });
  assert.equal(config.envName, "staging");
  // vars are non-inheritable: the environment only sees its own keys.
  assert.deepEqual(config.vars, {
    SHARED: "staging-value",
    STAGED: "yes",
  });
  assert.equal(config.workflows.length, 1);
  assert.equal(config.workflows[0].binding, "WF_STAGING");
  // Bindings are non-inheritable too: no top-level KV leaks into staging.
  assert.deepEqual(config.kvNamespaces, []);
  // secrets.required is non-inheritable; .dev.vars.staging replaces
  // .dev.vars entirely — the generic file is not merged in.
  assert.deepEqual(config.localDevEnv, { STAGING_SECRET: "staged" });

  // An environment that does not exist fails loudly.
  assert.throws(
    () => loadProjectConfig(path, { envName: "production" }),
    /no environment named "production"/,
  );

  // .dev.vars.<env> existing means only that file loads — BASE_SECRET from
  // the generic file is not visible under the environment.
  assert.deepEqual(loadLocalDevEnv(root, { envName: "staging" }), {
    SHARED_SECRET: "from-staging",
    STAGING_SECRET: "staged",
  });
  // Without an environment, the generic .dev.vars loads as before.
  assert.deepEqual(loadLocalDevEnv(root), {
    BASE_SECRET: "base",
    SHARED_SECRET: "from-base",
  });
});

test("wrangler env secret files: .dev.vars excludes .env, .env files merge", () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-mbt-env-dotenv-"));

  // .env family merge: least specific first, most specific last.
  writeFileSync(join(root, ".env"), 'A="base"\nB="base"\nC="base"\nD="base"\n');
  writeFileSync(join(root, ".env.staging"), 'B="env"\nC="env"\nD="env"\n');
  writeFileSync(join(root, ".env.local"), 'C="local"\nD="local"\n');
  writeFileSync(join(root, ".env.staging.local"), 'D="env-local"\n');

  assert.deepEqual(loadLocalDevEnv(root, { envName: "staging" }), {
    A: "base",
    B: "env",
    C: "local",
    D: "env-local",
  });
  assert.deepEqual(loadLocalDevEnv(root), {
    A: "base",
    B: "base",
    C: "local",
    D: "local",
  });

  // A generic .dev.vars excludes every .env file — no mixing with an
  // environment-specific .env.
  writeFileSync(join(root, ".dev.vars"), 'A="devvars"\nE="devvars"\n');
  assert.deepEqual(loadLocalDevEnv(root, { envName: "staging" }), {
    A: "devvars",
    E: "devvars",
  });

  // An environment-specific .dev.vars replaces both .dev.vars and .env files.
  writeFileSync(join(root, ".dev.vars.staging"), 'A="staging-devvars"\nF="s"\n');
  assert.deepEqual(loadLocalDevEnv(root, { envName: "staging" }), {
    A: "staging-devvars",
    F: "s",
  });
});


test("workflows.mbt.json retention adapter resolves plan and explicit durations", () => {
  const root = mkdtempSync(join(tmpdir(), "workflows-mbt-retention-cfg-"));
  const wranglerPath = join(root, "wrangler.jsonc");
  writeFileSync(
    wranglerPath,
    JSON.stringify({
      name: "retention-cfg",
      main: "src/index.ts",
      workflows: [{ name: "wf", binding: "WF", class_name: "Workflow" }],
    }),
  );

  writeFileSync(
    join(root, "workflows.mbt.json"),
    JSON.stringify({ retention: { plan: "paid" } }),
  );
  let config = loadProjectConfig(wranglerPath);
  assert.deepEqual(config.retentionPolicy, {
    successRetentionMs: 7 * 86_400_000,
    errorRetentionMs: 7 * 86_400_000,
  });

  writeFileSync(
    join(root, "workflows.mbt.json"),
    JSON.stringify({
      retention: { plan: "free", success: "1 hour" },
    }),
  );
  config = loadProjectConfig(wranglerPath);
  assert.deepEqual(config.retentionPolicy, {
    successRetentionMs: 3_600_000,
    errorRetentionMs: 3 * 86_400_000,
  });

  writeFileSync(
    join(root, "workflows.mbt.json"),
    JSON.stringify({ retention: { plan: "enterprise" } }),
  );
  assert.throws(
    () => loadProjectConfig(wranglerPath),
    /retention\.plan must be one of free, paid/,
  );

  writeFileSync(join(root, "workflows.mbt.json"), "{}");
  config = loadProjectConfig(wranglerPath);
  assert.equal(config.retentionPolicy, null);
});


async function startTcpServer(t, onConnection) {
  const server = createTcpServer(onConnection);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}

test("connect() secureTransport=on resolves opened only after TLS handshake", async (t) => {
  // Plain TCP server: the TCP connection succeeds but the TLS handshake can
  // never complete — `opened` must reject rather than resolving on `connect`.
  const port = await startTcpServer(t, (socket) => socket.end());
  const socket = connectSocket(`127.0.0.1:${port}`, {
    secureTransport: "on",
    allowHalfOpen: false,
  });
  // A directly-TLS socket was not upgraded — `upgraded` tracks startTls() on
  // the original socket only (pinned workerd semantics).
  assert.equal(socket.upgraded, false);
  assert.equal(socket.secureTransport, "on");
  await assert.rejects(socket.opened);
});

test("connect() startTls requires secureTransport=starttls and neuters the old socket", async (t) => {
  // Plaintext echo-less server: TCP stays open, the TLS handshake never
  // completes — the upgraded socket's `opened` stays unsettled.
  const received = [];
  const port = await startTcpServer(t, (socket) =>
    socket.on("data", (chunk) => received.push(Buffer.from(chunk))),
  );

  const plain = connectSocket(`127.0.0.1:${port}`, {
    secureTransport: "off",
    allowHalfOpen: false,
  });
  await plain.opened;
  assert.equal(plain.secureTransport, "off");
  assert.equal(plain.upgraded, false);
  assert.throws(() => plain.startTls(), TypeError);
  await plain.close();

  const starttls = connectSocket(`127.0.0.1:${port}`, {
    secureTransport: "starttls",
    allowHalfOpen: false,
  });
  await starttls.opened;
  assert.equal(starttls.secureTransport, "starttls");
  assert.equal(starttls.upgraded, false);

  // Capture the original stream objects — the upgrade must detach THESE
  // references (in-place takeover), not just replace the properties.
  const oldReadable = starttls.readable;
  const oldWritable = starttls.writable;
  const writer = oldWritable.getWriter();
  // A write issued before startTls() still flushes before the handshake.
  const pendingWrite = writer.write(
    new TextEncoder().encode("plain before upgrade"),
  );

  const upgraded = starttls.startTls();
  // Pinned testStartTlsBehaviorOnUpgrade: the ORIGINAL socket flips to
  // upgraded=true when its closed resolves; the returned secure socket stays
  // upgraded=false with secureTransport "on".
  assert.equal(starttls.upgraded, true);
  assert.equal(upgraded.upgraded, false);
  assert.equal(upgraded.secureTransport, "on");
  await starttls.closed;
  // The write issued before the upgrade flushed; held references are now
  // unusable.
  await pendingWrite;
  await assert.rejects(writer.write(new Uint8Array([0x41])), /detached/);
  await assert.rejects(oldReadable.getReader().read(), /detached/);
  assert.throws(() => starttls.startTls(), /already been called/);

  // Upgraded socket: handshake stalls on the plaintext server; opened never
  // resolves (suppress rejection/pending noise) — closing cleans up.
  upgraded.opened.catch(() => {});
  await upgraded.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    received.some((chunk) =>
      chunk.toString("utf8").includes("plain before upgrade"),
    ),
  );
});

function writeConsumerProject(dir, { workflows, secrets, source } = {}) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src/index.ts"),
    source ?? 'export class App extends Object {}\nexport default {};\n',
  );
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "doctor-test",
      main: "src/index.ts",
      workflows: workflows ?? [
        { name: "wf", binding: "WF", class_name: "App" },
      ],
      ...(secrets ? { secrets } : {}),
    }),
  );
  return join(dir, "wrangler.jsonc");
}

test("doctor fails loudly on an unreadable config and skips dependent checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workflows-mbt-doctor-"));
  const report = await runDoctor({
    configPath: join(dir, "missing-wrangler.jsonc"),
    storagePath: join(dir, "wf.sqlite"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].name, "config");
  assert.equal(report.checks[0].ok, false);
  for (const check of report.checks.slice(1)) {
    assert.equal(check.skipped, true, `${check.name} should be skipped`);
  }
});

test("doctor flags missing required secrets and unexported Workflow classes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workflows-mbt-doctor-"));
  const configPath = writeConsumerProject(dir, {
    secrets: { required: ["DEFINITELY_MISSING_SECRET"] },
    workflows: [{ name: "wf", binding: "WF", class_name: "MissingClass" }],
  });
  const report = await runDoctor({
    configPath,
    storagePath: join(dir, "wf.sqlite"),
    buildDir: join(dir, "bundles"),
  });
  const byName = Object.fromEntries(
    report.checks.map((check) => [check.name, check]),
  );
  assert.equal(report.ok, false);
  assert.match(byName.secrets.error, /DEFINITELY_MISSING_SECRET/);
  assert.equal(byName.bundle.ok, true);
  assert.equal(byName.module.ok, false);
  assert.match(byName.module.error, /MissingClass/);
});

test("doctor passes end to end on a minimal consumer project", async (t) => {
  if (!existsSync(join(repoRoot, "dist/workflows_core.mjs"))) {
    t.skip("requires the built kernel (npm run build:core)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "workflows-mbt-doctor-"));
  const configPath = writeConsumerProject(dir, {});
  const report = await runDoctor({
    configPath,
    storagePath: join(dir, "wf.sqlite"),
    buildDir: join(dir, "bundles"),
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.ok(report.checks.every((check) => check.ok));
});

const cliPath = join(repoRoot, "host", "cli.mjs");

function runCli(args) {
  // Run from an empty dir: no wrangler.jsonc exists, so any code path that
  // opens the runtime would fail with ENOENT instead of the expected result.
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "workflows-mbt-cli-")),
    encoding: "utf8",
  });
}

test("cli -h prints usage to stdout and exits 0", () => {
  for (const args of [["-h"], ["--help"], ["help"]]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `args=${args} stderr=${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
});

test("cli unknown commands exit 2 with usage instead of opening the runtime", () => {
  for (const args of [
    ["bogus"],
    ["bogus", "some-workflow"],
    ["bogus", "some-workflow", "some-instance"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 2, `args=${args} stderr=${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
  }
});

test("check-release-tag fails when the tag differs from package.json version", () => {
  const script = join(repoRoot, "scripts", "check-release-tag.mjs");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const match = spawnSync(process.execPath, [script, `v${pkg.version}`], { encoding: "utf8" });
  assert.equal(match.status, 0, match.stderr);
  const mismatch = spawnSync(process.execPath, [script, "v0.0.0-never"], { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match/);
});
