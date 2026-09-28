// Preflight for a fallback cutover: verify this project actually runs on
// workflows.mbt before traffic is routed to it.
//
//   workflows doctor --config wrangler.jsonc [--env <name>] [--storage <path>] [--json]
//
// Every check reuses the exact code path `workflows dev` hits, so a green
// doctor means the config parses, secrets resolve, storage opens, the kernel
// is present (it is prebuilt in release artifacts — no MoonBit toolchain
// needed), the source bundles, the Workflow classes export, and configured
// binding adapters are constructible.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalAdapters } from "./adapters.mjs";
import { loadProjectConfig } from "./config.mjs";
import { loadKernel } from "./kernel.mjs";
import { bundleWorkflow, loadWorkflowModule } from "./loader.mjs";
import { SQLiteStorage } from "./storage/sqlite.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const STAGES = [
  "config",
  "workflow bindings",
  "secrets",
  "storage",
  "kernel",
  "bundle",
  "module",
  "adapters",
];

export async function runDoctor({
  configPath = "wrangler.jsonc",
  storagePath,
  buildDir,
  envName = null,
  kernelPath = resolve(packageRoot, "dist/workflows_core.mjs"),
} = {}) {
  const checks = [];
  const warnings = [];

  const record = (name, entry) => {
    checks.push({ name, ok: true, ...entry });
    return checks.at(-1).ok !== false;
  };
  const run = async (name, fn) => {
    try {
      return record(name, { detail: (await fn()) ?? null });
    } catch (error) {
      checks.push({ name, ok: false, error: error?.message ?? String(error) });
      return false;
    }
  };
  const skip = (name, reason) =>
    checks.push({ name, ok: true, skipped: true, detail: reason });
  const skipRest = (from, reason) => {
    for (const name of STAGES.slice(STAGES.indexOf(from))) {
      if (!checks.some((c) => c.name === name)) skip(name, reason);
    }
  };

  let config = null;
  if (!(await run("config", async () => {
    config = loadProjectConfig(configPath, { storagePath, buildDir, envName });
    return `${config.workflows.length} workflow(s); env ${config.envName ?? "top-level"}; config ${config.configPath}`;
  }))) {
    skipRest("workflow bindings", "config failed");
    return { ok: false, checks, warnings };
  }

  await run("workflow bindings", async () => {
    for (const workflow of config.workflows) {
      if (!workflow.name || !workflow.binding || !workflow.className) {
        throw new Error("each workflows[] entry requires name, binding, and class_name");
      }
    }
    return config.workflows
      .map((w) => `${w.name} -> ${w.binding} -> ${w.className}`)
      .join(", ");
  });

  await run("secrets", async () => {
    const required = config.requiredSecrets ?? [];
    if (required.length === 0) return "no required secrets declared";
    const missing = required.filter((name) => config.localDevEnv[name] == null);
    if (missing.length) {
      throw new Error(
        `missing required secrets: ${missing.join(", ")} (expected in .dev.vars, .env, or the process environment)`,
      );
    }
    return `${required.length} required secret(s) present`;
  });

  await run("storage", async () => {
    // Opening runs the schema migration and creates the file/directory —
    // the same writability surface `dev` needs.
    const storage = new SQLiteStorage(config.storagePath);
    storage.close();
    return `sqlite opened at ${config.storagePath}`;
  });

  await run("kernel", async () => {
    await loadKernel(kernelPath);
    return `prebuilt MoonBit kernel at ${kernelPath}`;
  });

  const bundleOk = await run("bundle", async () => {
    return await bundleWorkflow(config);
  });

  if (bundleOk) {
    await run("module", async () => {
      const mod = await loadWorkflowModule(
        checks.find((c) => c.name === "bundle").detail,
      );
      for (const workflow of config.workflows) {
        if (typeof mod[workflow.className] !== "function") {
          throw new Error(
            `Workflow class ${workflow.className} is not exported by ${config.main}`,
          );
        }
      }
      return `exports ${config.workflows.map((w) => w.className).join(", ")}`;
    });
  } else {
    skip("module", "bundle failed");
  }

  await run("adapters", async () => {
    const adapters = buildLocalAdapters(config, {
      invokeQueue: async () => {
        throw new Error("queue delivery is not exercised by doctor");
      },
    });
    const bindings = Object.keys(adapters);
    return bindings.length
      ? `local adapters constructed for: ${bindings.join(", ")}`
      : "no KV/D1/R2/Queue/Service bindings configured";
  });

  if (config.ignoredWranglerFields?.length) {
    warnings.push(
      `wrangler fields ignored by this runtime: ${config.ignoredWranglerFields.join(", ")}`,
    );
  }

  return { ok: checks.every((check) => check.ok !== false), checks, warnings };
}

export function formatDoctorReport(report) {
  const lines = [];
  for (const check of report.checks) {
    if (check.ok === false) {
      lines.push(`FAIL ${check.name}: ${check.error}`);
    } else if (check.skipped) {
      lines.push(`skip ${check.name}: ${check.detail}`);
    } else {
      lines.push(`ok   ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }
  for (const warning of report.warnings) lines.push(`warn ${warning}`);
  lines.push(report.ok ? "doctor: all checks passed" : "doctor: FAILED");
  return lines.join("\n");
}
