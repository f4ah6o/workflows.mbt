import { bindings, defineConfig, exports } from "cf/config";

const workerName = "workflows-mbt-fallback-drill";

export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",
    env: {
      DRILL: bindings.workflow({
        name: "drill",
        worker: workerName,
        exportName: "DrillWorkflow",
      }),
    },
    exports: {
      DrillWorkflow: exports.workflow({ name: "drill" }),
    },
  },
});
