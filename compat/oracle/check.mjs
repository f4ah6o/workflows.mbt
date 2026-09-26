import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = join(root, "compat-results");
mkdirSync(resultsDir, { recursive: true });

const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "pinned";
if (!["pinned", "latest"].includes(mode)) throw new Error("mode must be pinned or latest");

const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));
const expectedApi = JSON.parse(readFileSync(join(root, "compat/oracle/api-surface.json"), "utf8"));
const expectedSchema = JSON.parse(readFileSync(join(root, "compat/oracle/wrangler-schema.json"), "utf8"));

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function extractBlock(text, marker) {
  const match = marker.exec(text);
  if (!match) return "";
  const start = text.indexOf("{", match.index);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(match.index, i + 1);
    }
  }
  return "";
}

function normalizeDeclaration(text) {
  return stripComments(text)
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:?|&=<>\[\]])\s*/g, "$1")
    .trim();
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function topLevelNames(block) {
  const start = block.indexOf("{");
  const body = start >= 0 ? block.slice(start + 1, -1) : block;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  const names = new Set();
  for (const line of stripComments(body).split("\n")) {
    if (braces === 0 && parens === 0 && brackets === 0) {
      const match = line.match(/^\s*(?:(?:public|protected|private|readonly|abstract|static|declare|export)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^;{=]*>)?\s*(?:\(|[?:])/);
      if (match && match[1] !== "constructor") names.add(match[1]);
    }
    for (const char of line) {
      if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      else if (char === "(") parens += 1;
      else if (char === ")") parens -= 1;
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets -= 1;
    }
  }
  return [...names].sort();
}

function extractApiSurface(text) {
  const markers = {
    Workflow: /declare\s+abstract\s+class\s+Workflow\b/,
    WorkflowInstance: /declare\s+abstract\s+class\s+WorkflowInstance\b/,
    WorkflowInstanceCreateOptions: /interface\s+WorkflowInstanceCreateOptions\b/,
    InstanceStatus: /type\s+InstanceStatus\b/,
    WorkflowInstanceSubscribeOptions: /type\s+WorkflowInstanceSubscribeOptions\b/,
    WorkflowStep: /(?:export\s+|declare\s+)?abstract\s+class\s+WorkflowStep\b/,
    WorkflowEntrypoint: /(?:export\s+|declare\s+)?abstract\s+class\s+WorkflowEntrypoint\b/,
  };
  const blocks = Object.fromEntries(
    Object.entries(markers).map(([name, marker]) => [name, extractBlock(text, marker)]),
  );
  for (const [name, block] of Object.entries(blocks)) {
    if (!block) throw new Error("Could not locate Cloudflare declaration: " + name);
  }
  const eventStart = text.search(/type\s+WorkflowInstanceEvent\b/);
  const eventEnd = text.search(/type\s+WorkflowInstanceEventType\b/);
  const eventText = eventStart >= 0 && eventEnd > eventStart ? text.slice(eventStart, eventEnd) : "";
  return {
    hashes: Object.fromEntries(
      Object.entries(blocks).map(([name, block]) => [name, fnv1a(normalizeDeclaration(block))]),
    ),
    members: {
      Workflow: topLevelNames(blocks.Workflow),
      WorkflowInstance: topLevelNames(blocks.WorkflowInstance),
      WorkflowInstanceCreateOptions: topLevelNames(blocks.WorkflowInstanceCreateOptions),
      WorkflowInstanceSubscribeOptions: topLevelNames(blocks.WorkflowInstanceSubscribeOptions),
      WorkflowStep: topLevelNames(blocks.WorkflowStep),
      WorkflowEntrypoint: topLevelNames(blocks.WorkflowEntrypoint),
    },
    instanceStatusValues: [...new Set([...blocks.InstanceStatus.matchAll(/\|\s*[\'"]([^\'"]+)[\'"]/g)].map((match) => match[1]))].sort(),
    eventTypes: [...new Set([...eventText.matchAll(/type:\s*[\'"]([^\'"]+)[\'"]/g)].map((match) => match[1]))].sort(),
  };
}

function findWorkflowBindingSchema(schema) {
  const candidates = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.properties && typeof node.properties === "object") {
      const keys = Object.keys(node.properties);
      if (["binding", "name", "class_name"].every((key) => keys.includes(key))) candidates.push(node);
    }
    for (const value of Object.values(node)) visit(value);
  }
  visit(schema);
  candidates.sort((a, b) => Object.keys(b.properties).length - Object.keys(a.properties).length);
  return candidates[0] ?? null;
}

function schemaKind(node) {
  if (!node || typeof node !== "object") return "unknown";
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) return node.type.slice().sort().join("|");
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return variants.map(schemaKind).sort().join("|");
  return "unknown";
}

function extractSchemaSurface(schema) {
  const binding = findWorkflowBindingSchema(schema);
  if (!binding) throw new Error("Could not locate Wrangler workflow binding schema");
  const trackedKinds = {};
  for (const key of Object.keys(expectedSchema.trackedKinds)) {
    trackedKinds[key] = schemaKind(binding.properties[key]);
  }
  return { workflowBindingKeys: Object.keys(binding.properties).sort(), trackedKinds };
}

function compareSet(label, expected, actual, drift) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of actual) if (!expectedSet.has(value)) drift.added.push(label + "." + value);
  for (const value of expected) if (!actualSet.has(value)) drift.removed.push(label + "." + value);
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

async function packPackage(pkg, spec, destination) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = await execFileP(npm, ["pack", pkg + "@" + spec, "--json", "--pack-destination", destination], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(packed.stdout);
  const filename = parsed.at(-1)?.filename;
  if (!filename) throw new Error("npm pack returned no filename for " + pkg + "@" + spec);
  const archive = join(destination, filename);
  const output = join(destination, pkg.replaceAll("/", "_").replaceAll("@", "") + "-" + spec);
  mkdirSync(output, { recursive: true });
  await execFileP("tar", ["-xzf", archive, "-C", output], { maxBuffer: 8 * 1024 * 1024 });
  return join(output, "package");
}

async function packageRoots() {
  if (mode === "pinned") {
    return {
      wrangler: join(root, "node_modules/wrangler"),
      workersTypes: join(root, "node_modules/@cloudflare/workers-types"),
      workerd: join(root, "node_modules/workerd"),
      cleanup() {},
    };
  }
  const temp = mkdtempSync(join(tmpdir(), "workflows-mbt-oracle-"));
  const roots = await Promise.all([
    packPackage("wrangler", "latest", temp),
    packPackage("@cloudflare/workers-types", "latest", temp),
    packPackage("workerd", "latest", temp),
  ]);
  return { wrangler: roots[0], workersTypes: roots[1], workerd: roots[2], cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

const roots = await packageRoots();
try {
  const versions = {
    wrangler: packageVersion(join(roots.wrangler, "package.json")),
    workersTypes: packageVersion(join(roots.workersTypes, "package.json")),
    workerd: packageVersion(join(roots.workerd, "package.json")),
  };
  if (mode === "pinned") {
    for (const [key, expected] of Object.entries({ wrangler: manifest.wrangler, workersTypes: manifest.workersTypes, workerd: manifest.workerd })) {
      if (versions[key] !== expected) throw new Error("Pinned " + key + " version mismatch: expected " + expected + ", got " + versions[key]);
    }
  }

  const typesPath = join(roots.workersTypes, "index.d.ts");
  const schemaPath = join(roots.wrangler, "config-schema.json");
  if (!existsSync(typesPath)) throw new Error("Missing " + typesPath);
  if (!existsSync(schemaPath)) throw new Error("Missing " + schemaPath);

  const api = extractApiSurface(readFileSync(typesPath, "utf8"));
  const schema = extractSchemaSurface(JSON.parse(readFileSync(schemaPath, "utf8")));
  const drift = { added: [], removed: [], changed: [] };
  for (const [name, expectedMembers] of Object.entries(expectedApi.members)) compareSet(name, expectedMembers, api.members[name] ?? [], drift);
  compareSet("InstanceStatus", expectedApi.instanceStatusValues, api.instanceStatusValues, drift);
  compareSet("WorkflowInstanceEvent", expectedApi.eventTypes, api.eventTypes, drift);
  compareSet("Wrangler.workflows[]", expectedSchema.workflowBindingKeys, schema.workflowBindingKeys, drift);

  for (const [name, expectedHash] of Object.entries(expectedApi.hashes)) {
    const actualHash = api.hashes[name];
    if (actualHash !== expectedHash) drift.changed.push(name + ": " + expectedHash + " -> " + actualHash);
  }
  for (const [key, expectedKind] of Object.entries(expectedSchema.trackedKinds)) {
    const actualKind = schema.trackedKinds[key];
    if (actualKind !== expectedKind) drift.changed.push("Wrangler.workflows[]." + key + ": " + expectedKind + " -> " + actualKind);
  }

  const result = {
    mode,
    checkedAt: new Date().toISOString(),
    compatibilityDate: manifest.compatibilityDate,
    versions,
    drift,
    pass: drift.added.length === 0 && drift.removed.length === 0 && drift.changed.length === 0,
  };
  writeFileSync(join(resultsDir, "drift-" + mode + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  roots.cleanup();
}
