import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const body = trimmed.slice(1, -1);
      if (first === "'") return body;
      return body
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  return trimmed;
}

export function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(normalized.slice(index + 1));
  }
  return out;
}

export function loadLocalDevEnv(root, { requiredSecrets = null, envName = null } = {}) {
  // Wrangler local secret files: .dev.vars and .env are mutually exclusive —
  // when any .dev.vars file applies, .env files are not loaded at all. Under a
  // named environment .dev.vars.<env> replaces .dev.vars entirely (secrets
  // must be defined per environment). Only when no .dev.vars file applies do
  // .env files load, and they merge rather than replace, with precedence
  // .env.<env>.local > .env.local > .env.<env> > .env.
  const at = (name) => join(root, name);
  const load = (path) => parseDotenv(readFileSync(path, "utf8"));

  let parsed = {};
  const envDevVars = envName == null ? null : at(`.dev.vars.${envName}`);
  if (envDevVars != null && existsSync(envDevVars)) {
    parsed = load(envDevVars);
  } else if (existsSync(at(".dev.vars"))) {
    parsed = load(at(".dev.vars"));
  } else {
    const order = envName == null
      ? [".env", ".env.local"]
      : [".env", `.env.${envName}`, ".env.local", `.env.${envName}.local`];
    for (const name of order) {
      const path = at(name);
      if (existsSync(path)) Object.assign(parsed, load(path));
    }
  }

  if (!Array.isArray(requiredSecrets)) return parsed;

  const out = {};
  for (const name of requiredSecrets) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) out[name] = parsed[name];
    else if (process.env[name] != null) out[name] = process.env[name];
  }
  return out;
}
