import { bindings, defineConfig, exports } from "cf/config";

const workerName = "workflows-mbt-basic-example";

export default defineConfig({
  worker: {
    name: workerName,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-09-26",
    env: {
      ORDER_WORKFLOW: bindings.workflow({
        name: "order-workflow",
        worker: workerName,
        exportName: "OrderWorkflow",
      }),
    },
    exports: {
      OrderWorkflow: exports.workflow({
        name: "order-workflow",
      }),
    },
  },
});
