#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { WorkflowRuntime } from "./engine.mjs";
import { runDoctor, formatDoctorReport } from "./doctor.mjs";
import { startWorkflowHttpServer } from "./server.mjs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positionals, flags };
}

// --storage takes a SQLite file path, or a postgres:// connection string to
// select the PostgreSQL backend for this invocation.
function storageOverride(flag) {
  const value = flag === true ? undefined : flag;
  if (typeof value === "string" && /^postgres(ql)?:\/\//i.test(value)) {
    return { storageUrl: value };
  }
  return { storagePath: value };
}

function usage(stream = console.error) {
  stream(`Usage:
  workflows dev [--config cloudflare.config.ts] [--mode <name>] [--host 127.0.0.1] [--port 8787] [--no-http]
  workflows doctor [--config cloudflare.config.ts] [--mode <name>] [--storage <sqlite-path|postgres-url>] [--json]
  workflows trigger <workflow> --params '{"name":"Alice"}' [--id <id>]
  workflows status <workflow> <instance-id>
  workflows event <workflow> <instance-id> <type> --payload '{"approved":true}'
  workflows pause|resume|terminate <workflow> <instance-id>
  workflows restart <workflow> <instance-id> [--from <name>] [--count 2] [--type do]
  workflows --version | --help | -h
Common options: --config <cloudflare.config.ts|wrangler.jsonc> --mode <name> --storage <sqlite-path|postgres-url>\nTracing compatibility: --tracing-scope <callback|invocation> (default callback)\nLegacy Wrangler config keeps --env <name>.`);
}

const COMMANDS = new Set([
  "dev",
  "trigger",
  "status",
  "event",
  "pause",
  "resume",
  "restart",
  "terminate",
]);

const { positionals, flags } = parse(process.argv.slice(2));
const [command, workflowName, instanceId, extra] = positionals;

if (flags.help === true || command === "help") {
  usage((line) => console.log(line));
} else if (flags.version === true || command === "version") {
  console.log(`${pkg.name} ${pkg.version}`);
} else if (command === "doctor") {
  const report = await runDoctor({
    configPath: flags.config === true ? undefined : flags.config,
    ...storageOverride(flags.storage),
    buildDir: flags["build-dir"] === true ? undefined : flags["build-dir"],
    envName: flags.env === true ? undefined : flags.env,
    modeName: flags.mode === true ? undefined : flags.mode,
    tracingScope: flags["tracing-scope"],
  });
  if (flags.json === true) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
} else if (!command || !COMMANDS.has(command)) {
  usage();
  process.exitCode = 2;
} else {
  const runtime = await WorkflowRuntime.open({
    configPath: flags.config === true ? undefined : flags.config,
    ...storageOverride(flags.storage),
    buildDir: flags["build-dir"] === true ? undefined : flags["build-dir"],
    envName: flags.env === true ? undefined : flags.env,
    modeName: flags.mode === true ? undefined : flags.mode,
    tracingScope: flags["tracing-scope"],
  });
  try {
    if (command === "dev") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const httpHost = flags.host === true ? "127.0.0.1" : (flags.host ?? "127.0.0.1");
      const httpPort = Number(flags.port === true ? 8787 : (flags.port ?? 8787));
      const server = flags["no-http"] === true
        ? null
        : await startWorkflowHttpServer(runtime, {
            host: httpHost,
            port: httpPort,
          });
      console.log(
        server
          ? `workflows dev listening on http://${httpHost}:${httpPort}`
          : "workflows dev running (HTTP disabled via --no-http)",
      );
      try {
        await runtime.dev({
          pollMs: Number(flags["poll-ms"] ?? 100),
          signal: controller.signal,
        });
      } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
      }
    } else if (command === "trigger") {
      if (!workflowName) throw new Error("trigger requires a workflow name");
      const instance = await runtime.trigger(
        workflowName,
        {
          id: flags.id === true ? undefined : flags.id,
          params: JSON.parse(flags.params === true || flags.params == null ? "{}" : flags.params),
        },
        { run: flags["enqueue-only"] !== true },
      );
      console.log(JSON.stringify(await instance.status()));
    } else {
      if (!workflowName || !instanceId) {
        throw new Error(`${command} requires workflow name and instance id`);
      }
      const workflow = runtime.workflowByName.get(workflowName);
      if (!workflow) throw new Error(`Unknown workflow: ${workflowName}`);
      const binding = runtime.env()[workflow.binding];
      const instance = await binding.get(instanceId);

      if (command === "status") {
        console.log(JSON.stringify(await instance.status()));
      } else if (command === "event") {
        if (!extra) throw new Error("event requires an event type");
        await instance.sendEvent({
          type: extra,
          payload: JSON.parse(
            flags.payload === true || flags.payload == null ? "null" : flags.payload,
          ),
        });
        await runtime.runPending();
        console.log(JSON.stringify(await instance.status()));
      } else if (command === "pause") {
        await instance.pause();
        console.log(JSON.stringify(await instance.status()));
      } else if (command === "resume") {
        await instance.resume();
        await runtime.runPending();
        console.log(JSON.stringify(await instance.status()));
      } else if (command === "restart") {
        const from = flags.from
          ? {
              name: flags.from,
              count: flags.count ? Number(flags.count) : undefined,
              type: flags.type === true ? undefined : flags.type,
            }
          : undefined;
        await instance.restart(from ? { from } : undefined);
        await runtime.runPending();
        console.log(JSON.stringify(await instance.status()));
      } else if (command === "terminate") {
        await instance.terminate();
        console.log(JSON.stringify(await instance.status()));
      }
    }
  } finally {
    await runtime.close();
  }
}
