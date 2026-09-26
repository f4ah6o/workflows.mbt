import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleWorkflow(config) {
  mkdirSync(config.buildDir, { recursive: true });
  const shim = join(packageRoot, "compat/cloudflare-workers/index.mjs");
  const outfile = join(
    config.buildDir,
    `${basename(config.main).replace(/\.[^.]+$/, "")}.workflows-mbt.mjs`,
  );

  await build({
    entryPoints: [config.main],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    logLevel: "silent",
    plugins: [
      {
        name: "workflows-mbt-cloudflare-compat",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:(workers|workflows)$/ }, () => ({
            path: shim,
          }));
        },
      },
    ],
  });

  return outfile;
}

export async function loadWorkflowModule(bundlePath) {
  const url = pathToFileURL(bundlePath);
  url.searchParams.set("v", `${Date.now()}-${Math.random()}`);
  return await import(url.href);
}
