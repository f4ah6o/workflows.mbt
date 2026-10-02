#!/usr/bin/env node
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { loadAndParseConfig } from "@cloudflare/config";

// cloudflare.config.ts generated/documented by `cf` imports its public helpers
// from "cf/config". A fallback consumer may intentionally have only
// workflows.mbt production dependencies installed, and the config itself can
// live outside this package's node_modules ancestry. Resolve that public
// specifier to the production @cloudflare/config dependency instead of
// relying on npm hoisting or requiring the full cf CLI at runtime.
const cloudflareConfigPublicUrl = import.meta.resolve("@cloudflare/config/public");
const cfConfigHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cf/config") {
      return {
        url: cloudflareConfigPublicUrl,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const configPath = resolve(process.argv[2] ?? "cloudflare.config.ts");
const modeArg = process.argv[3];
const mode = modeArg == null || modeArg === "" ? undefined : modeArg;

try {
  const { result } = await loadAndParseConfig(configPath, {
    isPreview: false,
    mode,
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length ? issue.path.join(".") + ": " : "";
        return path + issue.message;
      })
      .join("\n");
    throw new Error(`Invalid cloudflare.config.ts:\n${issues}`);
  }

  process.stdout.write(JSON.stringify(result.data));
} finally {
  cfConfigHook.deregister();
}
