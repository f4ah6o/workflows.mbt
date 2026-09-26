import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "jsonc-parser";

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

  return {
    root,
    configPath: absoluteConfig,
    main: resolve(root, wrangler.main),
    name: wrangler.name ?? "workflows-mbt-project",
    compatibilityDate: wrangler.compatibility_date ?? null,
    workflows: wrangler.workflows.map((workflow) => ({
      name: workflow.name,
      binding: workflow.binding,
      className: workflow.class_name,
      schedules: Array.isArray(workflow.schedules) ? workflow.schedules : [],
    })),
    storagePath: resolve(storagePath),
    buildDir: resolve(overrides.buildDir ?? join(root, ".workflows/bundles")),
    ignoredWranglerFields: Object.keys(wrangler).filter(
      (key) => !["name", "main", "compatibility_date", "workflows"].includes(key),
    ),
  };
}
