import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { loadLocalDevEnv } from "./env.mjs";
import { parseDuration } from "./duration.mjs";

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

function normalizeWorkflows(entries) {
  return entries.map((workflow) => ({
    name: workflow.name,
    binding: workflow.binding,
    className: workflow.class_name,
    schedules: Array.isArray(workflow.schedules) ? workflow.schedules : [],
    defaultRetention: workflow.default_retention ?? null,
  }));
}

export function loadProjectConfig(configPath = "wrangler.jsonc", overrides = {}) {
  const absoluteConfig = resolve(configPath);
  const root = dirname(absoluteConfig);
  const wrangler = readJsonc(absoluteConfig);

  // Named Wrangler environment overlay (--env): env.<name> inherits the
  // top-level config except for non-inheritable keys — vars, secrets, and
  // every binding family (workflows, KV, D1, R2, Queues, Services) must be
  // declared per environment and never fall back to the top level.
  const envName = overrides.envName ?? null;
  let overlay = {};
  if (envName != null) {
    const envs = wrangler.env;
    if (envs == null || typeof envs !== "object" || envs[envName] == null) {
      throw new Error(
        `wrangler config has no environment named "${envName}"`,
      );
    }
    overlay = envs[envName];
  }

  const main = overlay.main ?? wrangler.main;
  if (!main) throw new Error("wrangler config must define main");
  const workflowEntries = envName == null ? wrangler.workflows : overlay.workflows;
  if (!Array.isArray(workflowEntries) || workflowEntries.length === 0) {
    throw new Error("wrangler config must define at least one workflows[] binding");
  }

  const localPath = join(root, "workflows.mbt.json");
  const local = existsSync(localPath) ? readJsonc(localPath) : {};
  // Explicit overrides pick the backend: a storageUrl forces postgres, a
  // storagePath forces sqlite; otherwise workflows.mbt.json decides.
  const storageType = overrides.storageUrl != null
    ? "postgres"
    : overrides.storagePath != null
      ? "sqlite"
      : (local?.storage?.type ?? "sqlite");
  if (storageType !== "sqlite" && storageType !== "postgres") {
    throw new Error(
      `workflows.mbt.json storage.type must be one of sqlite, postgres`,
    );
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

  const secretsDecl = envName == null ? wrangler?.secrets : overlay?.secrets;
  const requiredSecrets = Array.isArray(secretsDecl?.required)
    ? secretsDecl.required
    : null;
  const localDevEnv = loadLocalDevEnv(root, { requiredSecrets, envName });

  const recognizedFields = [
    "name", "main", "compatibility_date", "compatibility_flags",
    "workflows", "vars", "secrets", "env",
    // Binding families whose local adapters are wired by adapters.mjs.
    "kv_namespaces", "d1_databases", "r2_buckets", "queues", "services",
  ];

  return {
    root,
    configPath: absoluteConfig,
    envName,
    main: resolve(root, main),
    name: overlay.name ?? wrangler.name ?? "workflows-mbt-project",
    compatibilityDate: overlay.compatibility_date ?? wrangler.compatibility_date ?? null,
    compatibilityFlags:
      overlay.compatibility_flags ?? wrangler.compatibility_flags ?? [],
    vars: (envName == null ? wrangler.vars : overlay.vars) ?? {},
    localDevEnv,
    requiredSecrets,
    workflows: normalizeWorkflows(workflowEntries),
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
      .map((service) => (typeof service === "string" ? { binding: service } : { binding: service?.binding }))
      .filter(({ binding }) => typeof binding === "string" && binding.length > 0),
    localAdapters: local?.adapters ?? {},
    retentionPolicy: resolveRetentionPolicy(local),
    limits: {
      streamBytes: local?.limits?.streamBytes ?? 256 * 1024 * 1024,
    },
    executorLeaseMs: local?.executor?.leaseMs ?? 30_000,
    storageType,
    storageUrl,
    storageSchema,
    storagePath: resolve(storagePath),
    buildDir: resolve(overrides.buildDir ?? join(root, ".workflows/bundles")),
    ignoredWranglerFields: Object.keys(wrangler).filter(
      (key) => !recognizedFields.includes(key),
    ),
  };
}
