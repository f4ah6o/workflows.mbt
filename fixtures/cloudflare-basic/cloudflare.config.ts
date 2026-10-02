import { bindings, defineConfig, exports } from "cf/config";

const workerName = "cloudflare-basic";

export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",
    env: {
      MY_WORKFLOW: bindings.workflow({
        name: "my-workflow",
        worker: workerName,
        exportName: "MyWorkflow",
      }),
    },
    exports: {
      MyWorkflow: exports.workflow({ name: "my-workflow" }),
    },
  },
});
