// Test-only downstream service for the consumer scenario. No dependencies —
// an ordinary Node http server that stands in for a payment/finalization API.
//
//   node external-service.mjs --port 9000 [--fail-first] [--hold-ms 1500]
//
// - Every request counts as a *call*; an *apply* is recorded per idempotency
//   key. A repeat call with a key already applied returns the stored record
//   with `deduplicated: true` — this is how a real downstream survives a
//   runtime that delivers the same business effect more than once.
// - --fail-first: the first call per key answers 503 (forces the workflow's
//   step retry policy to fire before the effect is accepted).
// - --hold-ms: the first apply per route holds its response open for N ms —
//   a deterministic window where the effect exists downstream but the
//   workflow side has not yet observed it (the crash-recovery case under
//   test). Replays never hold.
// - GET /stats returns the call/apply ledger for the evidence record.

import { createServer } from "node:http";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 0);
const failFirst = args.includes("--fail-first");
const holdIndex = args.indexOf("--hold-ms");
const holdMs = holdIndex >= 0 ? Number(args[holdIndex + 1]) : 0;

const calls = { charge: 0, finalize: 0 };
const applied = { charge: {}, finalize: {} };
const failedKeys = new Set();

function handle(route, request, response) {
  calls[route] += 1;
  const key = request.headers["idempotency-key"] ?? "anonymous";
  const store = applied[route];

  if (failFirst && !failedKeys.has(key + route)) {
    failedKeys.add(key + route);
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily unavailable", retryable: true }));
    return;
  }

  if (store[key]) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...store[key], deduplicated: true }));
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk.toString(); });
  request.on("end", () => {
    const record = {
      route,
      key,
      appliedAt: new Date().toISOString(),
      body: JSON.parse(body || "{}"),
      deduplicated: false,
    };
    store[key] = record;
    const reply = () => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(record));
    };
    if (holdMs > 0) setTimeout(reply, holdMs); else reply();
  });
}

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "POST" && url.pathname === "/charge") return handle("charge", request, response);
  if (request.method === "POST" && url.pathname === "/finalize") return handle("finalize", request, response);
  if (request.method === "GET" && url.pathname === "/stats") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ calls, applied, failedKeys: [...failedKeys] }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200); response.end("ok"); return;
  }
  response.writeHead(404); response.end("not found");
}).listen(port, "127.0.0.1", () => {
  console.log(`external-service listening on 127.0.0.1:${port} failFirst=${failFirst} holdMs=${holdMs}`);
});
