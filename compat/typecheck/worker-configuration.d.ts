// Mirrors the wrangler-generated `worker-configuration.d.ts` upstream, which
// fills `Cloudflare.GlobalProps.mainModule` so `ctx.exports` resolves to the
// loopback bindings of the main module's exports.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./main");
  }
}
