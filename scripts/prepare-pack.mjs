// npm `prepack`/`postpack` hooks for the runtime artifact.
//
//   prepack:  ensure the prebuilt MoonBit kernel exists (building it when
//             missing) and stage npm-shrinkwrap.json from the committed
//             package-lock.json. Consumers who extract the tarball can then
//             run `npm ci --omit=dev` and get the exact dependency set the
//             release was verified against — npm never packs package-lock.json.
//   postpack: remove the staged shrinkwrap so development installs keep using
//             package-lock.json.
//
// A pack failure may leave npm-shrinkwrap.json behind; it shows up as an
// untracked file in `git status` and is gitignored — delete it or rerun
// `node scripts/prepare-pack.mjs --cleanup`.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shrinkwrap = join(root, "npm-shrinkwrap.json");

if (process.argv.includes("--cleanup")) {
  rmSync(shrinkwrap, { force: true });
} else {
  const kernel = join(root, "dist", "workflows_core.mjs");
  if (!existsSync(kernel)) {
    execFileSync("npm", ["run", "build:core"], { cwd: root, stdio: "inherit" });
  }
  copyFileSync(join(root, "package-lock.json"), shrinkwrap);
}
