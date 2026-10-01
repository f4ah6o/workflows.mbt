// Upstream candidate resolver — resolves the verification target ONCE and
// shares it across every phase of a compat run.
//
//   node compat/candidate.mjs --mode pinned [--refresh] [--results-dir <dir>]
//   node compat/candidate.mjs --mode latest [--refresh]
//   node compat/candidate.mjs --candidate <candidate.json>   # inspect/validate
//
// Modes:
//   pinned  — the repository's committed dependency set. Versions, integrity,
//             and the real dependency graph are read from node_modules +
//             package-lock.json. Nothing is installed.
//   latest  — resolves @latest exactly once via npm, installs the exact tuple
//             into an isolated directory under compat-results/ (the repo's
//             node_modules and lockfile are never touched), and records the
//             resolved versions, npm integrity hashes, acquisition source,
//             resolution time, and Wrangler's real transitive runtime graph
//             (miniflare/workerd as installed — not a separately packed
//             workerd, which can differ).
//
// Consumption:
//   A resolved candidate persists at compat-results/candidate-<mode>.json.
//   Phase tools (check.mjs, run-differential.mjs, run-drill.mjs) consume the
//   persisted candidate via --candidate <path> or by default when the file
//   exists — they never re-resolve @latest. `--refresh` re-resolves; only the
//   run entry point passes it. Re-running phases against the same candidate
//   file reproduces the same verification target.
//
// Acquisition failures write {status: "acquisition-failure", ...} to the
// candidate file and exit non-zero, so downstream phases and the run verdict
// can distinguish "upstream could not be fetched" from "checked and clean".

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseJsonc } from "jsonc-parser";

const execFileP = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resultsDirFor(rootDir = root, env = process.env) {
  return env.WORKFLOWS_MBT_RESULTS_DIR
    ? resolve(env.WORKFLOWS_MBT_RESULTS_DIR)
    : join(rootDir, "compat-results");
}

const TRACKED_PACKAGES = {
  cf: "cf",
  vitePlugin: "@cloudflare/vite-plugin",
  vite: "vite",
  wrangler: "wrangler",
  workersTypes: "@cloudflare/workers-types",
  workerd: "workerd",
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function candidatePath(mode, resultsDir) {
  return join(resultsDir, "candidate-" + mode + ".json");
}

function candidateInstallDir(mode, resultsDir) {
  return join(resultsDir, "candidate-" + mode);
}

// The fixture config is the verification condition: compatibility_date and
// compatibility_flags under which wrangler dev runs the probe source are part
// of the candidate identity, not ambient environment.
export function verificationConditions(rootDir = root) {
  const manifest = readJson(join(rootDir, "compat/oracle/manifest.json"));
  const conditions = {
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: [],
    config: "compat/probes/cloudflare.config.ts",
  };
  const probeConfig = join(rootDir, conditions.config);
  if (existsSync(probeConfig)) {
    const source = readFileSync(probeConfig, "utf8");
    const date = source.match(/compatibilityDate\s*:\s*["']([^"']+)["']/);
    if (date) conditions.probesCompatibilityDate = date[1];
    const flags = source.match(/compatibilityFlags\s*:\s*\[([^\]]*)\]/s);
    if (flags) {
      conditions.compatibilityFlags = [...flags[1].matchAll(/["']([^"']+)["']/g)]
        .map((match) => match[1]);
    }
  }
  return conditions;
}

function gitCommit(rootDir = root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Flatten npm ls --json --all output into {name: version} covering the whole
// installed graph — this is Wrangler's real transitive runtime (miniflare,
// workerd, esbuild...) as installed, not a spec read from package.json.
function flattenLs(node, into = {}) {
  for (const [name, info] of Object.entries(node?.dependencies ?? {})) {
    if (info?.version && into[name] == null) into[name] = info.version;
    if (info?.dependencies) flattenLs(info, into);
  }
  return into;
}

async function npmLsGraph(dir) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileP(npm, ["ls", "--json", "--all", "--long=false"], {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  const flat = flattenLs(parsed);
  const count = Object.keys(flat).length;
  const interesting = {};
  for (const name of ["cf", "@cloudflare/vite-plugin", "vite", "@cloudflare/config", "wrangler", "miniflare", "workerd", "@cloudflare/workers-types", "esbuild", "@cloudflare/unenv-preset", "unenv"]) {
    if (flat[name]) interesting[name] = flat[name];
  }
  return { count, runtime: interesting, graph: flat };
}

// Integrity + tarball URL from package-lock.json for pinned packages, or from
// `npm view` for a freshly resolved registry spec.
function lockfileIntegrity(rootDir) {
  const lockPath = join(rootDir, "package-lock.json");
  if (!existsSync(lockPath)) return {};
  const lock = readJson(lockPath);
  const out = {};
  for (const [key, pkg] of Object.entries(TRACKED_PACKAGES)) {
    const entry = lock.packages?.["node_modules/" + pkg];
    if (entry?.integrity || entry?.resolved) {
      out[key] = { integrity: entry.integrity ?? null, resolved: entry.resolved ?? null };
    }
  }
  return out;
}

function nodeModulesVersion(rootDir, pkg) {
  return readJson(join(rootDir, "node_modules", pkg, "package.json")).version;
}

export async function resolvePinned(rootDir = root, resultsDir = resultsDirFor(rootDir)) {
  const versions = {
    cf: nodeModulesVersion(rootDir, "cf"),
    vitePlugin: nodeModulesVersion(rootDir, "@cloudflare/vite-plugin"),
    vite: nodeModulesVersion(rootDir, "vite"),
    wrangler: nodeModulesVersion(rootDir, "wrangler"),
    workersTypes: nodeModulesVersion(rootDir, "@cloudflare/workers-types"),
    workerd: nodeModulesVersion(rootDir, "workerd"),
  };
  const manifest = readJson(join(rootDir, "compat/oracle/manifest.json"));
  for (const [key, expected] of Object.entries({
    cf: manifest.cf,
    vitePlugin: manifest.vitePlugin,
    vite: manifest.vite,
    wrangler: manifest.wrangler,
    workersTypes: manifest.workersTypes,
    workerd: manifest.workerd,
  })) {
    if (versions[key] !== expected) {
      throw new Error("Pinned " + key + " version mismatch: manifest says " + expected + ", node_modules has " + versions[key]);
    }
  }
  const dependency = await npmLsGraph(rootDir);
  const candidate = {
    formatVersion: 1,
    mode: "pinned",
    status: "ok",
    resolvedAt: new Date().toISOString(),
    source: { type: "package-lock", lockfile: "package-lock.json" },
    requested: {
      cf: manifest.cf,
      vitePlugin: manifest.vitePlugin,
      vite: manifest.vite,
      wrangler: manifest.wrangler,
      workersTypes: manifest.workersTypes,
      workerd: manifest.workerd,
    },
    versions,
    integrity: lockfileIntegrity(rootDir),
    dependencyGraph: dependency.graph,
    runtime: dependency.runtime,
    dependencyCount: dependency.count,
    paths: {
      cfBin: join(rootDir, "node_modules/.bin/cf"),
      cfPkg: join(rootDir, "node_modules/cf"),
      vitePluginPkg: join(rootDir, "node_modules/@cloudflare/vite-plugin"),
      vitePkg: join(rootDir, "node_modules/vite"),
      wranglerBin: join(rootDir, "node_modules/.bin/wrangler"),
      wranglerPkg: join(rootDir, "node_modules/wrangler"),
      workersTypesPkg: join(rootDir, "node_modules/@cloudflare/workers-types"),
      workerdPkg: join(rootDir, "node_modules/workerd"),
      typesPath: join(rootDir, "node_modules/@cloudflare/workers-types/index.d.ts"),
      schemaPath: join(rootDir, "node_modules/wrangler/config-schema.json"),
    },
    installDir: null,
    commit: gitCommit(rootDir),
    conditions: verificationConditions(rootDir),
  };
  candidate.id = "pinned-" + sha256(JSON.stringify({ versions, integrity: candidate.integrity })).slice(0, 16);
  writeCandidate(candidate, resultsDir);
  return candidate;
}

async function npmView(pkg, spec, env) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileP(npm, ["view", pkg + "@" + spec, "--json"], {
    cwd: root,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  // npm view returns an array when the spec matches multiple versions.
  const entry = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  return {
    version: entry.version,
    integrity: entry.dist?.integrity ?? null,
    tarball: entry.dist?.tarball ?? null,
  };
}

export async function resolveLatest(rootDir = root, resultsDir = resultsDirFor(rootDir), { refresh = false, env = process.env } = {}) {
  const cPath = candidatePath("latest", resultsDir);
  const installDir = candidateInstallDir("latest", resultsDir);
  if (!refresh && existsSync(cPath)) {
    const existing = readJson(cPath);
    if (existing.status === "ok" && existsSync(existing.paths?.wranglerBin)) {
      return existing;
    }
  }

  mkdirSync(resultsDir, { recursive: true });
  const requested = {
    cf: "latest",
    vitePlugin: "latest",
    vite: "latest",
    wrangler: "latest",
    workersTypes: "latest",
    workerd: "latest",
  };
  const fail = (phase, error) => {
    const candidate = {
      formatVersion: 1,
      mode: "latest",
      status: "acquisition-failure",
      phase,
      error: error?.message ?? String(error),
      resolvedAt: new Date().toISOString(),
      requested,
      commit: gitCommit(rootDir),
      conditions: verificationConditions(rootDir),
    };
    candidate.id = "latest-failed-" + sha256(candidate.resolvedAt + candidate.error).slice(0, 12);
    writeFileSync(cPath, JSON.stringify(candidate, null, 2) + "\n");
    return candidate;
  };

  // 1. Resolve each tracked spec exactly once via npm view (records version,
  //    integrity, tarball URL — the acquisition evidence).
  let resolved;
  try {
    const [cf, vitePlugin, vite, wrangler, workersTypes, workerd] = await Promise.all([
      npmView("cf", "latest", env),
      npmView("@cloudflare/vite-plugin", "latest", env),
      npmView("vite", "latest", env),
      npmView("wrangler", "latest", env),
      npmView("@cloudflare/workers-types", "latest", env),
      npmView("workerd", "latest", env),
    ]);
    resolved = { cf, vitePlugin, vite, wrangler, workersTypes, workerd };
  } catch (error) {
    return fail("resolve", error);
  }

  // 2. Install the exact resolved tuple into an isolated dir — never into the
  //    repo's node_modules/lockfile. npm generates a lockfile inside the
  //    candidate dir, which is the re-runnable lock for this candidate.
  try {
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "package.json"), JSON.stringify({
      name: "workflows-mbt-upstream-candidate",
      private: true,
      dependencies: {
        cf: resolved.cf.version,
        "@cloudflare/vite-plugin": resolved.vitePlugin.version,
        vite: resolved.vite.version,
        wrangler: resolved.wrangler.version,
        "@cloudflare/workers-types": resolved.workersTypes.version,
        workerd: resolved.workerd.version,
      },
    }, null, 2) + "\n");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await execFileP(npm, ["install", "--no-audit", "--no-fund"], {
      cwd: installDir,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return fail("install", error);
  }

  // 3. Record the real installed dependency graph — the workerd/miniflare
  //    wrangler will actually start, which is what the differential verifies.
  let dependency;
  try {
    dependency = await npmLsGraph(installDir);
  } catch (error) {
    return fail("graph", error);
  }

  const versions = {
    cf: resolved.cf.version,
    vitePlugin: resolved.vitePlugin.version,
    vite: resolved.vite.version,
    wrangler: resolved.wrangler.version,
    workersTypes: resolved.workersTypes.version,
    workerd: resolved.workerd.version,
  };
  const candidate = {
    formatVersion: 1,
    mode: "latest",
    status: "ok",
    resolvedAt: new Date().toISOString(),
    source: {
      type: "npm-registry",
      registry: env.npm_config_registry ?? "https://registry.npmjs.org",
    },
    requested,
    versions,
    integrity: {
      cf: { integrity: resolved.cf.integrity, tarball: resolved.cf.tarball },
      vitePlugin: { integrity: resolved.vitePlugin.integrity, tarball: resolved.vitePlugin.tarball },
      vite: { integrity: resolved.vite.integrity, tarball: resolved.vite.tarball },
      wrangler: { integrity: resolved.wrangler.integrity, tarball: resolved.wrangler.tarball },
      workersTypes: { integrity: resolved.workersTypes.integrity, tarball: resolved.workersTypes.tarball },
      workerd: { integrity: resolved.workerd.integrity, tarball: resolved.workerd.tarball },
    },
    dependencyGraph: dependency.graph,
    runtime: dependency.runtime,
    dependencyCount: dependency.count,
    paths: {
      cfBin: join(installDir, "node_modules/.bin/cf"),
      cfPkg: join(installDir, "node_modules/cf"),
      vitePluginPkg: join(installDir, "node_modules/@cloudflare/vite-plugin"),
      vitePkg: join(installDir, "node_modules/vite"),
      wranglerBin: join(installDir, "node_modules/.bin/wrangler"),
      wranglerPkg: join(installDir, "node_modules/wrangler"),
      workersTypesPkg: join(installDir, "node_modules/@cloudflare/workers-types"),
      workerdPkg: join(installDir, "node_modules/workerd"),
      typesPath: join(installDir, "node_modules/@cloudflare/workers-types/index.d.ts"),
      schemaPath: join(installDir, "node_modules/wrangler/config-schema.json"),
    },
    installDir,
    commit: gitCommit(rootDir),
    conditions: verificationConditions(rootDir),
  };
  candidate.id = "latest-" + sha256(JSON.stringify({ versions, integrity: candidate.integrity })).slice(0, 16);
  writeCandidate(candidate, resultsDir);
  return candidate;
}

function writeCandidate(candidate, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(candidatePath(candidate.mode, resultsDir), JSON.stringify(candidate, null, 2) + "\n");
}

// Load a persisted candidate, or resolve one (reuse-if-present: never re-derives
// @latest while a usable candidate file exists).
export async function loadCandidate(mode, { candidatePath: explicit, resultsDir = resultsDirFor(), refresh = false, env = process.env } = {}) {
  if (explicit) {
    const candidate = readJson(resolve(explicit));
    validateCandidate(candidate, explicit);
    return candidate;
  }
  const persisted = candidatePath(mode, resultsDir);
  if (existsSync(persisted)) {
    const candidate = readJson(persisted);
    validateCandidate(candidate, persisted);
    return candidate;
  }
  return mode === "pinned"
    ? resolvePinned(root, resultsDir)
    : resolveLatest(root, resultsDir, { refresh, env });
}

export function validateCandidate(candidate, origin = "candidate.json") {
  if (!candidate || typeof candidate !== "object") throw new Error(origin + ": not an object");
  if (candidate.formatVersion !== 1) throw new Error(origin + ": unsupported formatVersion " + candidate.formatVersion);
  if (!["ok", "acquisition-failure"].includes(candidate.status)) {
    throw new Error(origin + ": unknown status " + JSON.stringify(candidate.status));
  }
  if (candidate.status === "ok") {
    for (const key of ["versions", "paths", "resolvedAt"]) {
      if (candidate[key] == null) throw new Error(origin + ": missing " + key);
    }
    for (const key of ["cfBin", "wranglerBin", "typesPath", "schemaPath"]) {
      if (!existsSync(candidate.paths[key])) {
        throw new Error(origin + ": candidate path missing on disk: " + candidate.paths[key]);
      }
    }
  }
  return candidate;
}

export function candidateUsable(candidate) {
  return candidate?.status === "ok";
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const mode = arg("mode") ?? "pinned";
  const explicit = arg("candidate");
  const resultsDir = arg("results-dir") ? resolve(arg("results-dir")) : resultsDirFor();
  const refresh = process.argv.includes("--refresh");

  try {
    let candidate;
    if (explicit) {
      candidate = validateCandidate(readJson(resolve(explicit)), explicit);
    } else if (mode === "pinned") {
      candidate = await resolvePinned(root, resultsDir);
    } else {
      candidate = await resolveLatest(root, resultsDir, { refresh });
    }
    console.log(JSON.stringify({
      id: candidate.id,
      mode: candidate.mode ?? mode,
      status: candidate.status,
      versions: candidate.versions ?? null,
      runtime: candidate.runtime ?? null,
      resolvedAt: candidate.resolvedAt,
      installDir: candidate.installDir ?? null,
      file: explicit ? resolve(explicit) : candidatePath(candidate.mode ?? mode, resultsDir),
    }, null, 2));
    if (candidate.status !== "ok") process.exitCode = 1;
  } catch (error) {
    console.error("candidate: " + (error?.message ?? error));
    process.exitCode = 1;
  }
}
