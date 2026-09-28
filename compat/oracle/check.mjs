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
// --write re-bases the committed API snapshot from the currently installed
// pinned packages instead of diffing. Review the resulting diff in git.
const writeSnapshot = process.argv.includes("--write");

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

// Declarations tracked as normalized-hash + top-level member set. Nested
// object types, option bags, callback shapes and discriminated-union payloads
// are hashed whole so a changed field/optionality/signature reports as a
// changed symbol even when its member names stay the same.
const API_MARKERS = {
  Workflow: /declare\s+abstract\s+class\s+Workflow\b/,
  WorkflowInstance: /declare\s+abstract\s+class\s+WorkflowInstance\b/,
  WorkflowInstanceCreateOptions: /interface\s+WorkflowInstanceCreateOptions\b/,
  InstanceStatus: /type\s+InstanceStatus\b/,
  WorkflowInstanceSubscribeOptions: /type\s+WorkflowInstanceSubscribeOptions\b/,
  WorkflowInstanceSubscription: /interface\s+WorkflowInstanceSubscription\b/,
  WorkflowInstanceTerminateOptions: /interface\s+WorkflowInstanceTerminateOptions\b/,
  WorkflowInstanceRestartOptions: /interface\s+WorkflowInstanceRestartOptions\b/,
  WorkflowInstanceLocationHint: /type\s+WorkflowInstanceLocationHint\b/,
  WorkflowError: /interface\s+WorkflowError\b/,
  WorkflowStep: /(?:export\s+|declare\s+)?abstract\s+class\s+WorkflowStep\b/,
  WorkflowEntrypoint: /(?:export\s+|declare\s+)?abstract\s+class\s+WorkflowEntrypoint\b/,
  ExecutionContext: /interface\s+ExecutionContext\b/,
  WorkflowEvent: /type\s+WorkflowEvent</,
  WorkflowStepEvent: /type\s+WorkflowStepEvent</,
  WorkflowStepContext: /type\s+WorkflowStepContext</,
  WorkflowStepConfig: /type\s+WorkflowStepConfig\b/,
  WorkflowStepRollbackConfig: /type\s+WorkflowStepRollbackConfig\b/,
  WorkflowStepRollbackOptions: /type\s+WorkflowStepRollbackOptions\b/,
  WorkflowRollbackContext: /type\s+WorkflowRollbackContext\b/,
  WorkflowRollbackHandler: /type\s+WorkflowRollbackHandler\b/,
  WorkflowDynamicDelayContext: /type\s+WorkflowDynamicDelayContext\b/,
  WorkflowDelayFunction: /type\s+WorkflowDelayFunction\b/,
  WorkflowCronSchedule: /type\s+WorkflowCronSchedule\b/,
  NonRetryableError: /class\s+NonRetryableError\b/,
};

// Single-statement scalar/literal union aliases tracked by normalized text
// hash. Covers discriminant-value and literal-option changes.
const API_LITERAL_TYPES = [
  "WorkflowBackoff",
  "WorkflowSleepDuration",
  "WorkflowTimeoutDuration",
  "WorkflowRetentionDuration",
  "WorkflowStepSensitivity",
  "WorkflowDurationLabel",
];

const API_MEMBER_TRACKED = [
  "Workflow",
  "WorkflowInstance",
  "WorkflowInstanceCreateOptions",
  "WorkflowInstanceSubscribeOptions",
  "WorkflowInstanceSubscription",
  "WorkflowInstanceTerminateOptions",
  "WorkflowInstanceRestartOptions",
  "WorkflowError",
  "WorkflowStep",
  "WorkflowEntrypoint",
  "ExecutionContext",
  "WorkflowEvent",
  "WorkflowStepEvent",
  "WorkflowStepContext",
  "WorkflowStepConfig",
  "WorkflowStepRollbackConfig",
  "WorkflowStepRollbackOptions",
  "WorkflowRollbackContext",
  "WorkflowDynamicDelayContext",
  "WorkflowCronSchedule",
];

// Variant payload shapes of the WorkflowInstanceEvent discriminated union:
// per event type, the top-level field names plus a normalized hash of the
// whole variant (so nested config changes are caught too).
function eventVariantShapes(eventText) {
  const shapes = {};
  let depth = 0;
  let start = -1;
  for (let i = 0; i < eventText.length; i += 1) {
    const char = eventText[i];
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const variant = eventText.slice(start, i + 1);
        const match = variant.match(/type:\s*["']([^"']+)["']/);
        if (match) {
          const name = match[1];
          const variantStart = variant.indexOf("{");
          const body = variantStart >= 0 ? variant.slice(variantStart + 1, -1) : variant;
          const fields = new Set();
          let inner = 0;
          for (const line of stripComments(body).split("\n")) {
            if (inner === 0) {
              const field = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:]/);
              if (field) fields.add(field[1]);
            }
            for (const c of line) {
              if (c === "{") inner += 1;
              else if (c === "}") inner -= 1;
            }
          }
          shapes[name] = {
            fields: [...fields].sort(),
            hash: fnv1a(normalizeDeclaration(variant)),
          };
        }
        start = -1;
      }
    }
  }
  return shapes;
}

function literalUnionHash(text, name) {
  const match = text.match(new RegExp("type\\s+" + name + "\\b\\s*=\\s*([^;]+);"));
  if (!match) throw new Error("Could not locate Cloudflare literal type: " + name);
  return fnv1a(normalizeDeclaration(match[1]));
}

function extractApiSurface(text) {
  const blocks = Object.fromEntries(
    Object.entries(API_MARKERS).map(([name, marker]) => [name, extractBlock(text, marker)]),
  );
  for (const [name, block] of Object.entries(blocks)) {
    if (!block) throw new Error("Could not locate Cloudflare declaration: " + name);
  }
  const eventStart = text.search(/type\s+WorkflowInstanceEvent\b/);
  const eventEnd = text.search(/type\s+WorkflowInstanceEventType\b/);
  const eventText = eventStart >= 0 && eventEnd > eventStart ? text.slice(eventStart, eventEnd) : "";
  const eventShapes = eventVariantShapes(eventText);
  return {
    hashes: Object.fromEntries(
      Object.entries(blocks).map(([name, block]) => [name, fnv1a(normalizeDeclaration(block))]),
    ),
    literalHashes: Object.fromEntries(
      API_LITERAL_TYPES.map((name) => [name, literalUnionHash(text, name)]),
    ),
    members: Object.fromEntries(
      API_MEMBER_TRACKED.map((name) => [name, topLevelNames(blocks[name])]),
    ),
    instanceStatusValues: [...new Set([...blocks.InstanceStatus.matchAll(/\|\s*[\'"]([^\'"]+)[\'"]/g)].map((match) => match[1]))].sort(),
    eventTypes: Object.keys(eventShapes).sort(),
    eventFields: Object.fromEntries(
      Object.entries(eventShapes).map(([name, shape]) => [name, shape.fields]),
    ),
    eventHashes: Object.fromEntries(
      Object.entries(eventShapes).map(([name, shape]) => [name, shape.hash]),
    ),
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

// Members of the local host/shim classes that back each tracked upstream
// class. The oracle must fail when a tracked upstream member loses its local
// implementation, not only when the upstream declaration itself changes.
const LOCAL_CLASS_SURFACES = {
  Workflow: ["host/binding.mjs", "WorkflowBinding"],
  WorkflowInstance: ["host/binding.mjs", "WorkflowInstanceHandle"],
  WorkflowStep: ["compat/cloudflare-workers/index.mjs", "WorkflowStep"],
  WorkflowEntrypoint: ["compat/cloudflare-workers/index.mjs", "WorkflowEntrypoint"],
  ExecutionContext: ["host/execution-context.mjs", "WorkerExecutionContext"],
};

const LOCAL_MEMBER_NOISE = new Set([
  "constructor", "if", "for", "while", "switch", "catch", "return",
  "throw", "else", "new", "typeof", "await", "function", "case",
]);

function localClassMembers(path, className) {
  const text = readFileSync(path, "utf8");
  const block = extractBlock(text, new RegExp("class\\s+" + className + "\\b"));
  if (!block) throw new Error("Could not locate local class: " + className);
  const names = new Set();
  for (const match of block.matchAll(
    /(?:^|\n)\s*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (!LOCAL_MEMBER_NOISE.has(match[1])) names.add(match[1]);
  }
  for (const match of block.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]);
  }
  return names;
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
  if (!writeSnapshot) {
  const schema = extractSchemaSurface(JSON.parse(readFileSync(schemaPath, "utf8")));
  const drift = { added: [], removed: [], changed: [] };
  for (const [name, expectedMembers] of Object.entries(expectedApi.members)) compareSet(name, expectedMembers, api.members[name] ?? [], drift);
  compareSet("InstanceStatus", expectedApi.instanceStatusValues, api.instanceStatusValues, drift);
  compareSet("WorkflowInstanceEvent", expectedApi.eventTypes, api.eventTypes, drift);
  for (const [name, expectedFields] of Object.entries(expectedApi.eventFields ?? {})) {
    compareSet("WorkflowInstanceEvent." + name, expectedFields, api.eventFields[name] ?? [], drift);
  }
  for (const [name, expectedHash] of Object.entries(expectedApi.eventHashes ?? {})) {
    const actualHash = api.eventHashes?.[name];
    if (actualHash !== expectedHash) drift.changed.push("WorkflowInstanceEvent." + name + ": " + expectedHash + " -> " + actualHash);
  }
  compareSet("Wrangler.workflows[]", expectedSchema.workflowBindingKeys, schema.workflowBindingKeys, drift);

  for (const [name, expectedHash] of Object.entries(expectedApi.hashes)) {
    const actualHash = api.hashes[name];
    if (actualHash !== expectedHash) drift.changed.push(name + ": " + expectedHash + " -> " + actualHash);
  }
  for (const [name, expectedHash] of Object.entries(expectedApi.literalHashes ?? {})) {
    const actualHash = api.literalHashes?.[name];
    if (actualHash !== expectedHash) drift.changed.push(name + ": " + expectedHash + " -> " + actualHash);
  }
  for (const [key, expectedKind] of Object.entries(expectedSchema.trackedKinds)) {
    const actualKind = schema.trackedKinds[key];
    if (actualKind !== expectedKind) drift.changed.push("Wrangler.workflows[]." + key + ": " + expectedKind + " -> " + actualKind);
  }

  const localSurface = {};
  for (const [surface, [file, className]] of Object.entries(LOCAL_CLASS_SURFACES)) {
    const members = localClassMembers(join(root, file), className);
    localSurface[surface] = [...members].sort();
    for (const member of expectedApi.members[surface] ?? []) {
      if (!members.has(member)) drift.removed.push("local." + surface + "." + member);
    }
  }

  const result = {
    mode,
    checkedAt: new Date().toISOString(),
    compatibilityDate: manifest.compatibilityDate,
    versions,
    localSurface,
    drift,
    pass: drift.added.length === 0 && drift.removed.length === 0 && drift.changed.length === 0,
  };
  writeFileSync(join(resultsDir, "drift-" + mode + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
  } else {
    const snapshot = { formatVersion: expectedApi.formatVersion ?? 1, source: expectedApi.source, ...api };
    writeFileSync(join(root, "compat/oracle/api-surface.json"), JSON.stringify(snapshot, null, 2) + "\n");
    console.log("wrote compat/oracle/api-surface.json");
  }
} finally {
  roots.cleanup();
}
