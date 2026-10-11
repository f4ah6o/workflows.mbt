import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Run against the pinned dependencies by default, or the exact isolated
// candidate used by a latest run. No network resolution occurs in this test.
const packageRoot = resolve(process.env.WORKFLOWS_MBT_TEST_ORACLE_DIR ?? root);

for (const fixture of ["compat/probes", "fixtures/drill"]) {
  test(`${fixture}: Vite loads the ESM plugin in a CommonJS candidate project`, () => {
    const dir = mkdtempSync(join(tmpdir(), "wfmbt-oracle-config-"));
    try {
      cpSync(join(root, fixture), dir, { recursive: true });
      // Reproduce the latest candidate's original module context: no type=module.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
      symlinkSync(join(packageRoot, "node_modules"), join(dir, "node_modules"),
        process.platform === "win32" ? "junction" : "dir");
      const viteUrl = pathToFileURL(join(packageRoot, "node_modules/vite/dist/node/index.js")).href;
      const script = `
        import assert from "node:assert/strict";
        const { loadConfigFromFile } = await import(${JSON.stringify(viteUrl)});
        const loaded = await loadConfigFromFile({ command: "serve", mode: "development" });
        assert.ok(loaded, "Vite must discover the oracle config");
        assert.ok(loaded.path.endsWith("vite.config.mts"));
        assert.ok(loaded.config.plugins.flat(Infinity).some(p => p?.name?.includes("cloudflare")),
          "the real Cloudflare plugin must load");
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: dir, encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
