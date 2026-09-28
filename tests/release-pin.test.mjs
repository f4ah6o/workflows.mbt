// The release path must not depend on MoonBit's moving `latest` channel —
// the emergency artifact is only reproducible if it installs the toolchain
// bytes recorded in .moonbit-toolchain.json, verified by sha256.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("release workflow installs the vendored toolchain, not the latest channel", () => {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(release, /install-toolchain\.mjs/, "release.yml must install via scripts/install-toolchain.mjs");
  assert.doesNotMatch(release, /version:\s*["']?latest/, "release.yml must not request a floating toolchain channel");
});

test("toolchain pin file records immutable release assets with sha256", () => {
  const pin = JSON.parse(readFileSync(join(root, ".moonbit-toolchain.json"), "utf8"));
  assert.match(pin.release?.tag ?? "", /^toolchain\//);
  for (const field of ["moonAsset", "moonSha256", "coreAsset", "coreSha256"]) {
    assert.ok(pin.release?.[field], `pin.release.${field} required`);
  }
  assert.match(pin.release.moonSha256, /^[0-9a-f]{64}$/);
  assert.match(pin.release.coreSha256, /^[0-9a-f]{64}$/);
});
