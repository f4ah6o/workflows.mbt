import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const oraclePort = Number(process.env.WORKFLOWS_MBT_ORACLE_PORT ?? "5173");
const oracleHost = process.env.WORKFLOWS_MBT_ORACLE_HOST ?? "127.0.0.1";

export default defineConfig({
  server: {
    host: oracleHost,
    port: oraclePort,
    strictPort: true,
  },
  plugins: [
    cloudflare({
      inspectorPort: false,
      persistState: false,
      types: { includeRuntime: false },
    }),
  ],
});
