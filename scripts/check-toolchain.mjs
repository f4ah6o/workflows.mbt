// Verifies the installed MoonBit toolchain matches .moonbit-toolchain.json.
// The binaries CDN only serves channel names (latest/nightly), so CI installs
// `latest` and this check turns upstream tool releases into an explicit drift
// signal instead of a silent version change.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, ".moonbit-toolchain.json"), "utf8"));

const moon = execFileSync("moon", ["version"], { encoding: "utf8" });
const moonc = execFileSync("moonc", ["-v"], { encoding: "utf8" });

const installedMoon = moon.match(/moon (\S+)/)?.[1];
const installedMoonc = moonc.match(/v?(\S+)/)?.[1];

const mismatches = [];
if (installedMoon !== pin.moon) {
  mismatches.push(`moon: pinned ${pin.moon}, installed ${installedMoon}`);
}
if (installedMoonc !== pin.moonc) {
  mismatches.push(`moonc: pinned ${pin.moonc}, installed ${installedMoonc}`);
}

if (mismatches.length > 0) {
  console.error("MoonBit toolchain drifted from .moonbit-toolchain.json:");
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error("Verify compatibility, then update .moonbit-toolchain.json.");
  process.exit(1);
}
console.log(`moon ${installedMoon} / moonc ${installedMoonc} match .moonbit-toolchain.json`);
