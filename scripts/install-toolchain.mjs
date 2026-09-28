// Installs the pinned MoonBit toolchain from this repository's own immutable
// release assets — NOT from cli.moonbitlang.com's moving `latest` channel.
//
//   node scripts/install-toolchain.mjs
//
// .moonbit-toolchain.json records the release tag, asset names, and sha256 of
// each tarball. The release workflow (and any emergency-fallback consumer)
// gets the exact bytes that were verified, independent of upstream channels.
//
// Layout matches setup-moonbit: moonbit tarball extracts into $MOON_HOME
// (default ~/.moon) producing bin/ + lib/ + include/; the core tarball
// extracts into $MOON_HOME/lib producing lib/core. $MOON_HOME/bin is appended
// to $GITHUB_PATH when present.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, ".moonbit-toolchain.json"), "utf8"));

if (!pin.release?.tag || !pin.release.moonSha256 || !pin.release.coreSha256) {
  console.error(".moonbit-toolchain.json lacks a vendored release pin (tag + asset sha256s)");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY ?? "f4ah6o/workflows.mbt";
const moonHome = process.env.MOON_HOME ?? join(homedir(), ".moon");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dest, buffer);
}

const tmp = join(tmpdir(), "moonbit-toolchain-" + pin.moon);
mkdirSync(tmp, { recursive: true });

for (const [asset, expected, dest] of [
  [pin.release.moonAsset, pin.release.moonSha256, join(tmp, "moonbit.tar.gz")],
  [pin.release.coreAsset, pin.release.coreSha256, join(tmp, "core.tar.gz")],
]) {
  const url = `https://github.com/${repo}/releases/download/${pin.release.tag}/${asset}`;
  await download(url, dest);
  const actual = sha256(dest);
  if (actual !== expected) {
    console.error(`sha256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`verified ${asset} sha256=${actual.slice(0, 12)}…`);
}

mkdirSync(moonHome, { recursive: true });
execFileSync("tar", ["xf", join(tmp, "moonbit.tar.gz"), "--directory", moonHome]);
execFileSync("tar", ["xf", join(tmp, "core.tar.gz"), "--directory", join(moonHome, "lib")]);
execFileSync("chmod", ["-R", "+x", join(moonHome, "bin")]);

if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, join(moonHome, "bin") + "\n");
}
process.env.PATH = join(moonHome, "bin") + ":" + process.env.PATH;

const moon = execFileSync(join(moonHome, "bin", "moon"), ["version"], { encoding: "utf8" });
const moonc = execFileSync(join(moonHome, "bin", "moonc"), ["-v"], { encoding: "utf8" });
const installedMoon = moon.match(/moon (\S+)/)?.[1];
const installedMoonc = moonc.match(/v?(\S+)/)?.[1];
if (installedMoon !== pin.moon || installedMoonc !== pin.moonc) {
  console.error(`installed ${installedMoon}/${installedMoonc} != pin ${pin.moon}/${pin.moonc}`);
  process.exit(1);
}
console.log(`installed pinned toolchain at ${moonHome}: moon ${installedMoon}, moonc ${installedMoonc}`);
