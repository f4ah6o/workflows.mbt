import { bindings, defineConfig, exports } from "cf/config";

const workerName = "workflows-mbt-compat-oracle";

export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",
    env: {
      ORACLE: bindings.workflow({
        name: "compat-oracle",
        worker: workerName,
        exportName: "OracleWorkflow",
      }),
    },
    exports: {
      OracleWorkflow: exports.workflow({ name: "compat-oracle" }),
    },
  },
});
