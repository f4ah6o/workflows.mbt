import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { loadLocalDevEnv } from "./env.mjs";

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

export function loadProjectConfig(configPath = "wrangler.jsonc", overrides = {}) {
  const absoluteConfig = resolve(configPath);
  const root = dirname(absoluteConfig);
  const wrangler = readJsonc(absoluteConfig);
  if (!wrangler.main) throw new Error("wrangler config must define main");
  if (!Array.isArray(wrangler.workflows) || wrangler.workflows.length === 0) {
    throw new Error("wrangler config must define at least one workflows[] binding");
  }

  const localPath = join(root, "workflows.mbt.json");
  const local = existsSync(localPath) ? readJsonc(localPath) : {};
  const configuredStorage = local?.storage?.path ?? ".workflows/workflows.db";
  const storagePath =
    overrides.storagePath ??
    (isAbsolute(configuredStorage) ? configuredStorage : join(root, configuredStorage));

  const requiredSecrets = Array.isArray(wrangler?.secrets?.required)
    ? wrangler.secrets.required
    : null;
  const localDevEnv = loadLocalDevEnv(root, { requiredSecrets });

  return {
    root,
    configPath: absoluteConfig,
    main: resolve(root, wrangler.main),
    name: wrangler.name ?? "workflows-mbt-project",
    compatibilityDate: wrangler.compatibility_date ?? null,
    compatibilityFlags: Array.isArray(wrangler.compatibility_flags)
      ? wrangler.compatibility_flags
      : [],
    vars: wrangler.vars && typeof wrangler.vars === "object" ? wrangler.vars : {},
    localDevEnv,
    requiredSecrets,
    workflows: wrangler.workflows.map((workflow) => ({
      name: workflow.name,
      binding: workflow.binding,
      className: workflow.class_name,
      schedules: Array.isArray(workflow.schedules) ? workflow.schedules : [],
      defaultRetention: workflow.default_retention ?? null,
    })),
    storagePath: resolve(storagePath),
    buildDir: resolve(overrides.buildDir ?? join(root, ".workflows/bundles")),
    ignoredWranglerFields: Object.keys(wrangler).filter(
      (key) => ![
        "name", "main", "compatibility_date", "compatibility_flags",
        "workflows", "vars", "secrets",
      ].includes(key),
    ),
  };
}
