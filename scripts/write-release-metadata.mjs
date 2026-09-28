// Emits release metadata on stdout: repository commit, MoonBit/Node toolchain
// basis, compatibility-oracle date + upstream version tuple, the latest drill
// result, and the known-differences summary from COMPATIBILITY.md.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "compat/oracle/manifest.json"), "utf8"));
const toolchain = JSON.parse(readFileSync(join(root, ".moonbit-toolchain.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const compatibility = readFileSync(join(root, "COMPATIBILITY.md"), "utf8");
const known = compatibility.split("## Known differences")[1]?.split("##")[2]?.trim()
  ?? compatibility.split("## Known differences")[1]?.split("## Compatibility claim")[0]?.trim()
  ?? "";

// --drill <path> overrides the drill record source (e.g. the artifact
// verification run inside the extracted tarball).
const drillIndex = process.argv.indexOf("--drill");
const drillPath = drillIndex >= 0
  ? resolve(process.argv[drillIndex + 1])
  : join(root, "compat-results/drill-latest.json");
const drill = existsSync(drillPath) ? JSON.parse(readFileSync(drillPath, "utf8")) : null;

console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  builtAt: new Date().toISOString(),
  toolchain: {
    moon: toolchain.moon,
    moonc: toolchain.moonc,
    node: pkg.engines?.node ?? ">=22",
  },
  oracle: {
    compatibilityDate: manifest.compatibilityDate,
    verifiedAt: manifest.verifiedAt,
    wrangler: manifest.wrangler,
    workersTypes: manifest.workersTypes,
    workerd: manifest.workerd,
  },
  drill: drill
    ? { checkedAt: drill.checkedAt, pass: drill.pass, outputsMatch: drill.outputsMatch, sourceDigest: drill.sourceDigest }
    : "not run",
  knownDifferences: known,
}, null, 2));
