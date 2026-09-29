// Upstream inventory extractor (issue 20260929 §2). Applies the committed
// discovery boundary (discovery-roots.json) to a resolved upstream candidate
// and produces a candidate inventory of machine fields only — id, source,
// kind, contract fingerprint, via, firstSeen/lastSeen. Classification never
// lives here; `matchedBy` records which profile's root spec discovered the
// item so tooling can join it to human classification.
//
//   node compat/inventory/extract.mjs --mode pinned
//       → compat-results/inventory-pinned.json (candidate inventory)
//   node compat/inventory/extract.mjs --baseline
//       → rewrites compat/inventory/upstream-api.json + upstream-config.json
//         from the pinned candidate (reviewed-baseline regeneration, like
//         oracle/check.mjs --write)
//   node compat/inventory/extract.mjs --types <index.d.ts> --schema <config-schema.json> --out <file>
//       → explicit sources (tests, one-off inspection)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { loadCandidate, resultsDirFor } from "../candidate.mjs";
import { loadDiscoverySpec } from "../coverage-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inventoryDir = process.env.WORKFLOWS_MBT_INVENTORY_DIR
  ? resolve(process.env.WORKFLOWS_MBT_INVENTORY_DIR)
  : join(root, "compat/inventory");

// ── Normalization / hashing (same normalizer family as oracle/check.mjs) ────

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export function normalizeDeclaration(text) {
  return stripComments(text)
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:?|&=<>\[\]])\s*/g, "$1")
    .trim();
}

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "fnv1a:" + hash.toString(16).padStart(8, "0");
}

function sha256Json(value) {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function sanitizeMember(name) {
  const clean = String(name).replace(/[^A-Za-z0-9_$]/g, "_");
  return clean.length > 0 ? clean : "unnamed";
}

// ── workers-types registry ────────────────────────────────────────────────
//
// Registry keys are `container:name`; container is `global`, a module name
// (`cloudflare:workers`), or `ns:<Qualified>` for ambient namespaces. Modules
// declared as `declare module "x" { export = Ns }` index Ns's *exported*
// members under the module container; namespaces themselves register as
// `ns:Ns` containers so qualified references (`Rpc.X`) resolve.

function buildRegistry(sourceFile) {
  const registry = new Map(); // container:name -> {name, container, node}
  const moduleNamespaces = new Map(); // module name -> namespace name (export =)
  const namespaces = new Map(); // namespace name -> ModuleBlock statements

  const declName = (node) => {
    if (ts.isVariableStatement(node)) return null;
    return node.name?.text ?? null;
  };

  const register = (container, name, node) => {
    if (name) registry.set(container + ":" + name, { name, container, node });
  };

  // Pass 1: containers + namespaces.
  const namespaceStatements = (node) => {
    const body = node.body;
    return body && ts.isModuleBlock(body) ? body.statements : [];
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt)) {
      const name = stmt.name.text;
      if (ts.isStringLiteral(stmt.name)) {
        const body = namespaceStatements(stmt);
        const exportEq = body.find(
          (inner) => ts.isExportAssignment(inner) && inner.isExportEquals,
        );
        if (exportEq && ts.isIdentifier(exportEq.expression)) {
          moduleNamespaces.set(name, exportEq.expression.text);
        } else {
          for (const inner of body) {
            const innerName = ts.isVariableStatement(inner)
              ? null
              : declName(inner);
            for (const n of innerName ? [innerName] : (ts.isVariableStatement(inner) ? inner.declarationList.declarations.map((d) => d.name.text) : [])) {
              register(name, n, inner);
            }
          }
        }
      } else {
        namespaces.set(name, namespaceStatements(stmt));
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        register("global", decl.name.text, stmt);
      }
      continue;
    }
    register("global", declName(stmt), stmt);
  }

  // Pass 2: module = namespace aliases + qualified namespace members.
  for (const [moduleName, namespaceName] of moduleNamespaces) {
    for (const stmt of namespaces.get(namespaceName) ?? []) {
      if (!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const names = ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations.map((d) => d.name.text)
        : [declName(stmt)];
      for (const n of names) register(moduleName, n, stmt);
    }
  }
  for (const [namespaceName, statements] of namespaces) {
    for (const stmt of statements) {
      const names = ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations.map((d) => d.name.text)
        : [declName(stmt)];
      for (const n of names) {
        registry.set("global:" + namespaceName + "." + n, {
          name: namespaceName + "." + n,
          container: "global",
          node: stmt,
        });
        registry.set("ns:" + namespaceName + ":" + n, {
          name: n,
          container: "ns:" + namespaceName,
          node: stmt,
        });
      }
    }
  }
  return registry;
}

// Extract item members for one declaration node. Returns
// Map<memberName, Node[]> — overloads merge under one member.
function memberNodes(node) {
  const members = new Map();
  const push = (name, child) => {
    if (!members.has(name)) members.set(name, []);
    members.get(name).push(child);
  };
  const typeMembers = (type) => {
    if (ts.isTypeLiteralNode(type)) {
      for (const m of type.members) memberNodesFromElement(m, push);
    } else if (ts.isUnionTypeNode(type)) {
      type.types.forEach((variant, index) => {
        const literal = discriminantName(variant);
        push(literal ?? "variant-" + index, variant);
      });
    }
  };
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    for (const m of node.members) memberNodesFromElement(m, push);
  } else if (ts.isTypeAliasDeclaration(node)) {
    typeMembers(node.type);
  } else if (ts.isEnumDeclaration(node)) {
    for (const m of node.members) push(m.name.text, m);
  }
  return members;
}

function memberNodesFromElement(element, push) {
  if (ts.isMethodSignature(element) || ts.isMethodDeclaration(element)
    || ts.isPropertySignature(element) || ts.isPropertyDeclaration(element)
    || ts.isGetAccessorDeclaration(element) || ts.isSetAccessorDeclaration(element)) {
    const name = element.name?.getText();
    if (name && name !== "constructor") push(sanitizeMember(name), element);
  } else if (ts.isCallSignatureDeclaration(element)) {
    push("[call]", element);
  } else if (ts.isConstructSignatureDeclaration(element) || ts.isConstructorDeclaration(element)) {
    return; // constructors stay inside the declaration fingerprint
  } else if (ts.isIndexSignatureDeclaration(element)) {
    push("[index]", element);
  }
}

// Discriminant for a union variant: a type literal with a `type:` string
// literal field, or a bare literal type — gives the member a readable ID.
function discriminantName(type) {
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return type.literal.text;
  if (ts.isTypeLiteralNode(type)) {
    for (const m of type.members) {
      if (ts.isPropertySignature(m) && m.name?.getText() === "type"
        && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) {
        return m.type.literal.text;
      }
    }
  }
  return null;
}

// Collect referenced entity names from a node: TypeReferenceNode covers
// annotations, generics, heritage clauses (extends/implements lower to it).
function referencedNames(node) {
  const names = new Set();
  const visit = (child) => {
    if (ts.isTypeReferenceNode(child)) {
      names.add(entityNameText(child.typeName));
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return names;
}

function entityNameText(entityName) {
  if (ts.isIdentifier(entityName)) return entityName.text;
  return entityNameText(entityName.left) + "." + entityNameText(entityName.right);
}

function resolveReference(registry, qualified, referrerContainer) {
  // 1. qualified global namespace member (Rpc.X)
  if (registry.has("global:" + qualified)) return "global:" + qualified;
  // 2. module namespace alias (CloudflareWorkersModule.X)
  const dot = qualified.indexOf(".");
  if (dot > 0) {
    const head = qualified.slice(0, dot);
    const tail = qualified.slice(dot + 1);
    for (const [moduleName, namespaceName] of MODULE_NAMESPACES_HINT) {
      if (namespaceName === head && registry.has(moduleName + ":" + tail)) {
        return moduleName + ":" + tail;
      }
    }
    if (registry.has("ns:" + head + ":" + tail)) return "ns:" + head + ":" + tail;
  }
  // 3. same container as the referencer
  if (registry.has(referrerContainer + ":" + qualified)) return referrerContainer + ":" + qualified;
  // 4. global
  if (registry.has("global:" + qualified)) return "global:" + qualified;
  return null;
}

// Namespace names bound to a module by `export =`; filled per extraction.
let MODULE_NAMESPACES_HINT = new Map();

const MODULE_ALIAS_HINT_SEED = [["cloudflare:workers", "CloudflareWorkersModule"]];

function itemId(container, name, member) {
  const base = (container === "global" ? "global" : container === "wrangler" ? "wrangler" : container.startsWith("ns:") ? "global." + container.slice(3) : container) + "." + name;
  return member ? base + "." + member : base;
}

function fingerprintOf(nodes, sourceFile) {
  const text = nodes.map((n) => n.getText(sourceFile)).join("\n");
  return fnv1a(normalizeDeclaration(text));
}

// ── Extraction: workers-types ──────────────────────────────────────────────

function matchesGlob(pattern, name) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

export function extractWorkersTypes(typesText, spec, { includeDeferred = true } = {}) {
  const sourceFile = ts.createSourceFile("index.d.ts", typesText, ts.ScriptTarget.Latest, true);
  const registry = buildRegistry(sourceFile);
  MODULE_NAMESPACES_HINT = new Map(MODULE_ALIAS_HINT_SEED);
  // Learn module->namespace bindings from the file itself.
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt) && ts.isStringLiteral(stmt.name)) {
      const body = stmt.body && ts.isModuleBlock(stmt.body) ? stmt.body.statements : [];
      const eq = body.find((n) => ts.isExportAssignment(n) && n.isExportEquals);
      if (eq && ts.isIdentifier(eq.expression)) MODULE_NAMESPACES_HINT.set(stmt.name.text, eq.expression.text);
    }
  }

  const items = new Map(); // id -> item
  const referencedKeys = new Set();
  const matchedKeys = new Set();
  const worklist = []; // [{key, via}]

  const addItem = (key, kind, { via, member, memberOf, profile, fingerprintNodes } = {}) => {
    const entry = registry.get(key);
    if (!entry) return null;
    const id = itemId(entry.container, entry.name, member);
    if (items.has(id)) {
      if (via && !items.get(id).via.includes(via)) items.get(id).via.push(via);
      return id;
    }
    const nodes = fingerprintNodes ?? [entry.node];
    const memberList = kind === "member" ? [] : [...memberNodes(entry.node).keys()].sort();
    items.set(id, {
      id,
      source: "workers-types",
      kind,
      container: entry.container,
      name: entry.name,
      ...(member ? { member } : {}),
      ...(memberOf ? { memberOf } : {}),
      ...(via ? { via: [via] } : { via: [] }),
      matchedBy: profile ?? null,
      contract: {
        fingerprint: fingerprintOf(nodes, sourceFile),
        membersHash: memberList.length ? fnv1a(memberList.join("\n")) : null,
      },
    });
    return id;
  };

  // Roots: per active-profile spec, match container declarations by name.
  const unmatchedRoots = [];
  for (const profile of spec.profileOrder) {
    for (const rootSpec of spec.roots?.[profile]?.workersTypes ?? []) {
      let matched = 0;
      for (const [key, entry] of registry) {
        if (entry.container !== rootSpec.container) continue;
        if (!rootSpec.names.some((pattern) => matchesGlob(pattern, entry.name))) continue;
        matched += 1;
        if (matchedKeys.has(key)) {
          throw new Error("discovery boundary overlap: " + key + " matched by more than one profile root");
        }
        matchedKeys.add(key);
        const id = addItem(key, "declaration", { profile });
        // Member closure: every member becomes an item; references found in a
        // member node attribute `via` to the member item, references elsewhere
        // in the declaration attribute to the declaration item.
        for (const [member, nodes] of memberNodes(entry.node)) {
          const memberId = addItem(key, "member", { member, memberOf: id, profile, fingerprintNodes: nodes });
          if (memberId) for (const n of nodes) worklist.push({ node: n, via: memberId, container: entry.container });
        }
        worklist.push({ node: entry.node, via: id, container: entry.container });
      }
      if (matched === 0) {
        unmatchedRoots.push(profile + ":" + rootSpec.container + ":" + rootSpec.names.join(","));
      }
    }
  }
  if (unmatchedRoots.length) {
    throw new Error("discovery roots matched nothing: " + unmatchedRoots.join("; "));
  }

  // Reference closure: transitively pull in referenced declarations that
  // resolve inside this file (lib.dom / built-ins simply do not resolve).
  // Walked once per node; `via` records the finest referrer (member item when
  // the reference sits inside a member signature).
  const walked = new Set();
  const walk = (node, via, container) => {
    if (!node || walked.has(node)) return;
    walked.add(node);
    for (const name of referencedNames(node)) {
      const targetKey = resolveReference(registry, name, container);
      if (!targetKey) continue;
      const target = registry.get(targetKey);
      const targetId = itemId(target.container, target.name);
      if (items.has(targetId)) {
        const existing = items.get(targetId);
        if (via && !existing.via.includes(via)) existing.via.push(via);
        continue;
      }
      matchedKeys.add(targetKey);
      referencedKeys.add(targetKey);
      const refId = addItem(targetKey, "referenced-type", { via });
      if (refId) walk(target.node, refId, target.container);
    }
  };
  while (worklist.length) {
    const { node, via, container } = worklist.shift();
    walk(node, via, container);
  }

  // Top-level candidacy: registry entries not matched and not referenced fall
  // into the deferred workers-platform scope — recorded, never in an active
  // denominator.
  const deferred = [];
  if (includeDeferred) {
    for (const [key, entry] of registry) {
      if (matchedKeys.has(key) || referencedKeys.has(key)) continue;
      if (items.has(itemId(entry.container, entry.name))) continue;
      if (entry.container.startsWith("ns:")) continue; // covered via global qualified name
      deferred.push({
        id: itemId(entry.container, entry.name),
        source: "workers-types",
        kind: "declaration",
        container: entry.container,
        name: entry.name,
        matchedBy: "workers-platform",
        contract: { fingerprint: fingerprintOf([entry.node], sourceFile) },
      });
    }
  }

  return {
    items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
    deferred: deferred.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ── Extraction: wrangler config-schema.json ────────────────────────────────

const SCHEMA_NON_CONTRACT_KEYS = new Set(["description", "markdownDescription", "$comment", "deprecatedMessage", "markdownDeprecationMessage"]);

function resolveSchemaRef(schema, ref) {
  const match = ref.match(/^#\/definitions\/(.+)$/);
  if (!match) return null;
  return schema.definitions?.[match[1]] ?? null;
}

// Canonical subtree with $refs resolved (cycles collapse back to the ref).
function canonicalSchema(node, schema, seen = new Set()) {
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    const target = resolveSchemaRef(schema, node.$ref);
    if (!target || seen.has(node.$ref)) return { $ref: node.$ref };
    seen.add(node.$ref);
    const resolved = canonicalSchema(target, schema, seen);
    seen.delete(node.$ref);
    const rest = { ...node };
    delete rest.$ref;
    return canonicalMerge(resolved, Object.keys(rest).length ? canonicalSchema(rest, schema, seen) : {});
  }
  if (Array.isArray(node)) return node.map((v) => canonicalSchema(v, schema, new Set(seen)));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_NON_CONTRACT_KEYS.has(key)) continue;
    out[key] = canonicalSchema(value, schema, new Set(seen));
  }
  return out;
}

function canonicalMerge(a, b) {
  return { ...(a ?? {}), ...(b ?? {}) };
}

// One level of member expansion: object → properties; array → items object.
function schemaMembers(node, schema) {
  const resolved = node?.$ref ? canonicalSchema(node, schema) : node;
  const effective = resolved ?? node;
  if (effective?.type === "array" && effective.items) {
    const items = effective.items.$ref ? canonicalSchema(effective.items, schema) : effective.items;
    return Object.entries(items?.properties ?? {});
  }
  if (effective?.properties) return Object.entries(effective.properties);
  if (effective?.additionalProperties && typeof effective.additionalProperties === "object") {
    const inner = effective.additionalProperties.$ref
      ? canonicalSchema(effective.additionalProperties, schema)
      : effective.additionalProperties;
    return Object.entries(inner?.properties ?? {});
  }
  return [];
}

function schemaItemsForPath(path, node, schema, profile, depth, out) {
  const id = "wrangler." + path;
  const members = schemaMembers(node, schema);
  out.set(id, {
    id,
    source: "wrangler-schema",
    kind: "config-subtree",
    container: "wrangler",
    name: path,
    matchedBy: profile,
    via: [],
    contract: {
      fingerprint: sha256Json(canonicalSchema(node, schema)),
      membersHash: members.length ? fnv1a(members.map(([k]) => k).sort().join("\n")) : null,
    },
  });
  if (depth <= 0) return;
  for (const [key, child] of members) {
    schemaItemsForPath(path + "." + sanitizeMember(key), child, schema, profile, depth - 1, out);
  }
}

export function extractWranglerSchema(schema, spec) {
  const items = new Map();
  const missing = [];
  const rootProps = schema.definitions?.RawConfig?.properties ?? schema.properties ?? {};
  for (const profile of spec.profileOrder) {
    for (const path of spec.roots?.[profile]?.wranglerSchema ?? []) {
      const node = rootProps[path];
      if (!node) {
        missing.push(profile + ":wrangler." + path);
        continue;
      }
      schemaItemsForPath(path, node, schema, profile, 2, items);
    }
  }
  if (missing.length) throw new Error("wrangler schema roots not found: " + missing.join("; "));
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Candidate inventory + baseline merge ───────────────────────────────────

export function buildCandidateInventory({ typesText, schema, spec, upstream }) {
  const api = extractWorkersTypes(typesText, spec);
  const config = extractWranglerSchema(schema, spec);
  return {
    formatVersion: 1,
    upstream: upstream ?? null,
    api: api.items,
    config,
    deferred: api.deferred,
  };
}

// Merge a fresh candidate inventory into a committed baseline: machine
// fields refresh, firstSeen is never rewritten, vanished ids are recorded
// under `removed` (their classification rows stay, and the validator reports
// them as stale).
export function mergeBaseline(existing, items, observedIn) {
  const baseline = existing ?? { formatVersion: 1, items: [], removed: [] };
  const byId = new Map((baseline.items ?? []).map((item) => [item.id, item]));
  const merged = [];
  const removed = new Map((baseline.removed ?? []).map((entry) => [entry.id, entry]));
  for (const item of items) {
    const prior = byId.get(item.id);
    removed.delete(item.id);
    merged.push({
      ...item,
      firstSeen: prior?.firstSeen ?? observedIn,
      lastSeen: observedIn,
    });
    byId.delete(item.id);
  }
  for (const stale of byId.values()) {
    removed.set(stale.id, { id: stale.id, firstSeen: stale.firstSeen, lastSeen: stale.lastSeen });
  }
  return {
    ...baseline,
    items: merged.sort((a, b) => a.id.localeCompare(b.id)),
    removed: [...removed.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function writeBaselines(rootDir, inventory, upstream) {
  const dir = join(rootDir, "compat/inventory");
  const apiPath = join(dir, "upstream-api.json");
  const configPath = join(dir, "upstream-config.json");
  const api = mergeBaseline(readJsonIfExists(apiPath), inventory.api, upstream);
  const config = mergeBaseline(readJsonIfExists(configPath), inventory.config, upstream);
  api.source = "@cloudflare/workers-types";
  api.upstream = upstream;
  api.deferred = inventory.deferred;
  config.source = "wrangler/config-schema.json";
  config.upstream = upstream;
  writeFileSync(apiPath, JSON.stringify(api, null, 2) + "\n");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { apiPath, configPath };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const resultsDir = resultsDirFor(root);
  const spec = loadDiscoverySpec(inventoryDir);
  try {
    let typesText, schema, upstream;
    if (arg("types") && arg("schema")) {
      typesText = readFileSync(resolve(arg("types")), "utf8");
      schema = JSON.parse(readFileSync(resolve(arg("schema")), "utf8"));
      upstream = { version: arg("version") ?? "fixture", candidateId: "fixture" };
    } else {
      const mode = arg("mode") ?? "pinned";
      const candidate = await loadCandidate(mode, {
        candidatePath: arg("candidate"),
        resultsDir,
      });
      if (candidate.status !== "ok") {
        throw new Error("candidate not usable: " + (candidate.error ?? candidate.status));
      }
      typesText = readFileSync(candidate.paths.typesPath, "utf8");
      schema = JSON.parse(readFileSync(candidate.paths.schemaPath, "utf8"));
      upstream = {
        version: candidate.versions.workersTypes,
        wrangler: candidate.versions.wrangler,
        workerd: candidate.versions.workerd,
        candidateId: candidate.id,
      };
    }
    const inventory = buildCandidateInventory({ typesText, schema, spec, upstream });
    if (process.argv.includes("--baseline")) {
      const { apiPath, configPath } = writeBaselines(root, inventory, upstream);
      console.log("wrote " + apiPath + " (" + inventory.api.length + " items, " + inventory.deferred.length + " deferred)");
      console.log("wrote " + configPath + " (" + inventory.config.length + " items)");
    } else {
      const out = arg("out") ?? join(resultsDir, "inventory-" + (arg("mode") ?? "pinned") + ".json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({
        ...inventory,
        generatedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      console.log("wrote " + out + " (" + inventory.api.length + " api items, " + inventory.config.length + " config items, " + inventory.deferred.length + " deferred)");
    }
  } catch (error) {
    console.error("extract: " + (error?.message ?? error));
    process.exitCode = 1;
  }
}
