#!/usr/bin/env node
// Release guard: the `npm pack` tarball is named and versioned from
// package.json, while the GitHub Release is named from the pushed tag. If a
// version bump is forgotten, tag v0.2.0 would happily publish a release that
// installs @f4ah6o/workflows-mbt@0.1.0. This check fails the release before
// packaging when the two disagree.
//
//   node scripts/check-release-tag.mjs <tag>
//   GITHUB_REF_NAME=v0.1.0 node scripts/check-release-tag.mjs

import { readFileSync } from "node:fs";

export function tagMatchesPackageVersion(tag, version) {
  return String(tag ?? "").trim().replace(/^v/, "") === version;
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

if (!tag) {
  console.error("usage: check-release-tag.mjs <tag> (or set GITHUB_REF_NAME)");
  process.exit(2);
}
if (!tagMatchesPackageVersion(tag, pkg.version)) {
  console.error(
    `release tag ${tag} does not match package.json version ${pkg.version} — ` +
      "bump package.json (or fix the tag) before releasing",
  );
  process.exit(1);
}
console.log(`release tag ${tag} matches package.json version ${pkg.version}`);
