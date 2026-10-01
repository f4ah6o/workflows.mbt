#!/usr/bin/env node
import { resolve } from "node:path";
import { loadAndParseConfig } from "@cloudflare/config";

const configPath = resolve(process.argv[2] ?? "cloudflare.config.ts");
const modeArg = process.argv[3];
const mode = modeArg == null || modeArg === "" ? undefined : modeArg;

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
