import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { loadLocalDevEnv } from "./env.mjs";
import { parseDuration } from "./duration.mjs";

const cloudflareConfigReader = fileURLToPath(
  new URL("./cloudflare-config-reader.mjs", import.meta.url),
);

function readJsonc(path) {
  const errors = [];
  const value = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    throw new Error(`Invalid JSONC in ${path}: ${JSON.stringify(errors)}`);
  }
  return value;
}

function resolveConfigPath(configPath) {
  if (configPath != null) return resolve(configPath);
  const cfPath = resolve("cloudflare.config.ts");
  if (existsSync(cfPath)) return cfPath;
  const wranglerJsonc = resolve("wrangler.jsonc");
  if (existsSync(wranglerJsonc)) return wranglerJsonc;
  const wranglerJson = resolve("wrangler.json");
  if (existsSync(wranglerJson)) return wranglerJson;
  throw new Error(
    "No Cloudflare project config found. Expected cloudflare.config.ts (preferred) or legacy wrangler.jsonc/wrangler.json.",
  );
}

function isCloudflareConfig(path) {
  return path.endsWith("cloudflare.config.ts") ||
    path.endsWith("cloudflare.config.mts") ||
    path.endsWith("cloudflare.config.js") ||
    path.endsWith("cloudflare.config.mjs");
}

function readCloudflareConfig(path, modeName) {
  try {
    const output = execFileSync(
      process.execPath,
      [cloudflareConfigReader, path, modeName ?? ""],
      {
        cwd: dirname(path),
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(output);
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    throw new Error(
      stderr || error?.message || `Failed to load Cloudflare config: ${path}`,
    );
  }
}

// Cloudflare account-plan retention defaults (see
// workflows/reference/limits). A local runtime has no account plan, so one is
// only applied when workflows.mbt.json declares `retention.plan` or explicit
// `retention.success`/`retention.error` durations.
const PLAN_RETENTION_MS = {
  free: { successRetentionMs: 3 * 86_400_000, errorRetentionMs: 3 * 86_400_000 },
  paid: { successRetentionMs: 7 * 86_400_000, errorRetentionMs: 7 * 86_400_000 },
};

function resolveRetentionPolicy(local) {
  const retention = local?.retention;
  if (retention == null) return null;
  if (typeof retention !== "object") {
    throw new Error("workflows.mbt.json retention must be an object");
  }
  let policy = {};
  if (retention.plan != null) {
    const plan = PLAN_RETENTION_MS[retention.plan];
    if (!plan) {
      throw new Error(
        `workflows.mbt.json retention.plan must be one of ${Object.keys(PLAN_RETENTION_MS).join(", ")}`,
      );
    }
    policy = { ...plan };
  }
  if (retention.success != null) {
    policy.successRetentionMs = parseDuration(retention.success, "retention.success");
  }
  if (retention.error != null) {
    policy.errorRetentionMs = parseDuration(retention.error, "retention.error");
  }
  if (policy.successRetentionMs == null && policy.errorRetentionMs == null) {
    throw new Error(
      "workflows.mbt.json retention must set a plan or at least one duration",
    );
  }
  return policy;
}

function localSettings(root, overrides) {
  const localPath = join(root, "workflows.mbt.json");
  const local = existsSync(localPath) ? readJsonc(localPath) : {};
  const storageType = overrides.storageUrl != null
    ? "postgres"
    : overrides.storagePath != null
      ? "sqlite"
      : (local?.storage?.type ?? "sqlite");
  if (storageType !== "sqlite" && storageType !== "postgres") {
    throw new Error("workflows.mbt.json storage.type must be one of sqlite, postgres");
  }
  const configuredStorage = local?.storage?.path ?? ".workflows/workflows.db";
  const storagePath =
    overrides.storagePath ??
    (isAbsolute(configuredStorage) ? configuredStorage : join(root, configuredStorage));
  const storageUrl = overrides.storageUrl ?? local?.storage?.url ?? null;
  const storageSchema = local?.storage?.schema ?? null;
  if (storageType === "postgres" && storageUrl == null) {
    throw new Error(
      'workflows.mbt.json storage.url is required when storage.type is "postgres"',
    );
  }
  return {
    local,
    storageType,
    storageUrl,
    storageSchema,
    storagePath: resolve(storagePath),
    buildDir: resolve(overrides.buildDir ?? join(root, ".workflows/bundles")),
  };
}

function commonLocalFields(settings) {
  return {
    localAdapters: settings.local?.adapters ?? {},
    retentionPolicy: resolveRetentionPolicy(settings.local),
    limits: {
      streamBytes: settings.local?.limits?.streamBytes ?? 256 * 1024 * 1024,
    },
    executorLeaseMs: settings.local?.executor?.leaseMs ?? 30_000,
    storageType: settings.storageType,
    storageUrl: settings.storageUrl,
    storageSchema: settings.storageSchema,
    storagePath: settings.storagePath,
    buildDir: settings.buildDir,
  };
}

function normalizeWranglerWorkflows(entries) {
  return entries.map((workflow) => ({
    name: workflow.name,
    binding: workflow.binding,
    bindings: [workflow.binding],
    className: workflow.class_name,
    schedules: Array.isArray(workflow.schedules) ? workflow.schedules : [],
    defaultRetention: workflow.default_retention ?? null,
  }));
}

function loadWranglerProjectConfig(absoluteConfig, overrides) {
  const root = dirname(absoluteConfig);
  const wrangler = readJsonc(absoluteConfig);
  const envName = overrides.envName ?? null;
  let overlay = {};
  if (envName != null) {
    const envs = wrangler.env;
    if (envs == null || typeof envs !== "object" || envs[envName] == null) {
      throw new Error(`wrangler config has no environment named "${envName}"`);
    }
    overlay = envs[envName];
  }
  if (overrides.modeName != null) {
    throw new Error("--mode is for cloudflare.config.ts; use legacy --env with Wrangler config");
  }

  const main = overlay.main ?? wrangler.main;
  if (!main) throw new Error("wrangler config must define main");
  const workflowEntries = envName == null ? wrangler.workflows : overlay.workflows;
  if (!Array.isArray(workflowEntries) || workflowEntries.length === 0) {
    throw new Error("wrangler config must define at least one workflows[] binding");
  }

  const settings = localSettings(root, overrides);
  const secretsDecl = envName == null ? wrangler?.secrets : overlay?.secrets;
  const requiredSecrets = Array.isArray(secretsDecl?.required)
    ? secretsDecl.required
    : null;
  const localDevEnv = loadLocalDevEnv(root, { requiredSecrets, envName });

  const recognizedFields = [
    "name", "main", "compatibility_date", "compatibility_flags",
    "workflows", "vars", "secrets", "env",
    "kv_namespaces", "d1_databases", "r2_buckets", "queues", "services",
  ];

  return {
    root,
    configPath: absoluteConfig,
    configFormat: "wrangler",
    envName,
    modeName: null,
    main: resolve(root, main),
    name: overlay.name ?? wrangler.name ?? "workflows-mbt-project",
    compatibilityDate: overlay.compatibility_date ?? wrangler.compatibility_date ?? null,
    compatibilityFlags:
      overlay.compatibility_flags ?? wrangler.compatibility_flags ?? [],
    vars: (envName == null ? wrangler.vars : overlay.vars) ?? {},
    localDevEnv,
    requiredSecrets,
    workflows: normalizeWranglerWorkflows(workflowEntries),
    kvNamespaces: ((envName == null ? wrangler.kv_namespaces : overlay.kv_namespaces) ?? [])
      .map((kv) => ({ binding: kv?.binding }))
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    d1Databases: ((envName == null ? wrangler.d1_databases : overlay.d1_databases) ?? [])
      .map((db) => ({ binding: db?.binding, database_name: db?.database_name }))
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    r2Buckets: ((envName == null ? wrangler.r2_buckets : overlay.r2_buckets) ?? [])
      .map((bucket) => ({ binding: bucket?.binding, bucket_name: bucket?.bucket_name }))
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    queueProducers: ((envName == null ? wrangler.queues?.producers : overlay.queues?.producers) ?? [])
      .map((producer) => ({ binding: producer?.binding, queue: producer?.queue }))
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    serviceBindings: ((envName == null ? wrangler.services : overlay.services) ?? [])
      .map((service) =>
        typeof service === "string" ? { binding: service } : { binding: service?.binding }
      )
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    ignoredWranglerFields: Object.keys(wrangler).filter(
      (key) => !recognizedFields.includes(key),
    ),
    ignoredCloudflareBindings: [],
    ...commonLocalFields(settings),
  };
}

function normalizeCloudflareRetention(value) {
  if (value == null) return null;
  return {
    success_retention: value.successRetention,
    error_retention: value.errorRetention,
  };
}

function normalizeCloudflareWorkflows(worker) {
  const exportsConfig = worker.exports ?? {};
  const env = worker.env ?? {};
  const workflows = [];

  for (const [className, workflowExport] of Object.entries(exportsConfig)) {
    if (workflowExport?.type !== "workflow") continue;
    const matches = Object.entries(env).filter(([, binding]) =>
      binding?.type === "workflow" &&
      binding.name === workflowExport.name &&
      binding.exportName === className &&
      (binding.worker === worker.name || binding.worker == null)
    );
    if (matches.length === 0) {
      throw new Error(
        `cloudflare.config.ts workflow export "${className}" must have at least one matching worker.env bindings.workflow() entry for "${workflowExport.name}"`,
      );
    }
    const bindings = matches.map(([binding]) => binding);
    const schedules = workflowExport.schedules == null
      ? []
      : Array.isArray(workflowExport.schedules)
        ? workflowExport.schedules
        : [workflowExport.schedules];
    workflows.push({
      name: workflowExport.name,
      binding: bindings[0],
      bindings,
      className,
      schedules,
      defaultRetention: normalizeCloudflareRetention(workflowExport.defaultRetention),
    });
  }

  if (workflows.length === 0) {
    throw new Error(
      "cloudflare.config.ts must declare at least one worker.exports workflow with a matching worker.env workflow binding",
    );
  }
  return workflows;
}

function loadCloudflareProjectConfig(absoluteConfig, overrides) {
  if (overrides.envName != null) {
    throw new Error("--env is for legacy Wrangler config; use --mode with cloudflare.config.ts");
  }
  const root = dirname(absoluteConfig);
  const modeName = overrides.modeName ?? undefined;
  const config = readCloudflareConfig(absoluteConfig, modeName);
  const worker = config?.worker;
  if (!worker || typeof worker !== "object") {
    throw new Error("cloudflare.config.ts must define worker");
  }
  if (typeof worker.entrypoint !== "string" || worker.entrypoint.length === 0) {
    throw new Error("cloudflare.config.ts worker.entrypoint must resolve to a source path");
  }

  const settings = localSettings(root, overrides);
  const env = worker.env ?? {};
  const vars = {};
  const requiredSecrets = [];
  const kvNamespaces = [];
  const d1Databases = [];
  const r2Buckets = [];
  const queueProducers = [];
  const serviceBindings = [];
  const ignoredCloudflareBindings = [];

  for (const [binding, value] of Object.entries(env)) {
    switch (value?.type) {
      case "text":
      case "json":
        vars[binding] = value.value;
        break;
      case "secret":
        requiredSecrets.push(binding);
        break;
      case "workflow":
        break;
      case "kv":
        kvNamespaces.push({ binding, name: value.name ?? null });
        break;
      case "d1":
        d1Databases.push({
          binding,
          database_name: value.name ?? null,
          database_id: value.id ?? null,
        });
        break;
      case "r2":
        r2Buckets.push({ binding, bucket_name: value.name ?? null });
        break;
      case "queue":
        queueProducers.push({ binding, queue: value.name ?? null });
        break;
      case "worker":
        serviceBindings.push({ binding, service: value.worker ?? null });
        break;
      default:
        ignoredCloudflareBindings.push(binding);
        break;
    }
  }

  const localDevEnv = loadLocalDevEnv(root, {
    requiredSecrets,
    envName: modeName ?? null,
  });

  return {
    root,
    configPath: absoluteConfig,
    configFormat: "cloudflare",
    envName: null,
    modeName: modeName ?? null,
    main: resolve(root, worker.entrypoint),
    name: worker.name ?? "workflows-mbt-project",
    compatibilityDate: worker.compatibilityDate ?? null,
    compatibilityFlags: worker.compatibilityFlags ?? [],
    vars,
    localDevEnv,
    requiredSecrets,
    workflows: normalizeCloudflareWorkflows(worker),
    kvNamespaces,
    d1Databases,
    r2Buckets,
    queueProducers,
    serviceBindings,
    ignoredWranglerFields: [],
    ignoredCloudflareBindings,
    ...commonLocalFields(settings),
  };
}

export function loadProjectConfig(configPath = null, overrides = {}) {
  const absoluteConfig = resolveConfigPath(configPath);
  return isCloudflareConfig(absoluteConfig)
    ? loadCloudflareProjectConfig(absoluteConfig, overrides)
    : loadWranglerProjectConfig(absoluteConfig, overrides);
}
