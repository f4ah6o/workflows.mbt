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

export function loadLocalDevEnv(root, { requiredSecrets = null } = {}) {
  const devVars = join(root, ".dev.vars");
  const dotenv = join(root, ".env");
  const path = existsSync(devVars) ? devVars : (existsSync(dotenv) ? dotenv : null);
  const parsed = path == null ? {} : parseDotenv(readFileSync(path, "utf8"));

  if (!Array.isArray(requiredSecrets)) return parsed;

  const out = {};
  for (const name of requiredSecrets) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) out[name] = parsed[name];
    else if (process.env[name] != null) out[name] = process.env[name];
  }
  return out;
}
