#!/usr/bin/env node
import { WorkflowRuntime } from "./engine.mjs";
import { startWorkflowHttpServer } from "./server.mjs";

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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

function usage() {
  console.error(`Usage:
  workflows dev --config wrangler.jsonc [--host 127.0.0.1] [--port 8787] [--no-http]
  workflows trigger <workflow> --params '{"name":"Alice"}' [--id <id>]
  workflows status <workflow> <instance-id>
  workflows event <workflow> <instance-id> <type> --payload '{"approved":true}'
  workflows pause|resume|terminate <workflow> <instance-id>
  workflows restart <workflow> <instance-id> [--from <name>] [--count 2] [--type do]
Common options: --config <wrangler.jsonc> --storage <sqlite-path>`);
}

const { positionals, flags } = parse(process.argv.slice(2));
const [command, workflowName, instanceId, extra] = positionals;
if (!command) {
  usage();
  process.exitCode = 2;
} else {
  const runtime = await WorkflowRuntime.open({
    configPath: flags.config ?? "wrangler.jsonc",
    storagePath: flags.storage,
    buildDir: flags["build-dir"],
  });
  try {
    if (command === "dev") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const server = flags["no-http"] === true
        ? null
        : await startWorkflowHttpServer(runtime, {
            host: flags.host === true ? "127.0.0.1" : (flags.host ?? "127.0.0.1"),
            port: Number(flags.port === true ? 8787 : (flags.port ?? 8787)),
          });
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
      } else {
        usage();
        process.exitCode = 2;
      }
    }
  } finally {
    await runtime.close();
  }
}
