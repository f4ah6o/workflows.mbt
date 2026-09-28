// Regression: a probe that fails over HTTP (non-2xx) or times out must be
// recorded as an execution error in the differential result — not throw and
// erase the whole run's evidence. drift-record depends on these fields.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { collectTraces, diffRun } from "../compat/probe-client.mjs";

const OK_TRACE = {
  probe: "ok",
  status: { status: "complete", output: { done: true } },
  events: [
    { type: "workflow_queued" },
    { type: "workflow_started" },
    { type: "workflow_completed" },
  ],
};

function stubServer() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const probe = JSON.parse(body).probe;
      if (probe === "err") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
        return;
      }
      if (probe === "hang") return; // never respond — exercises the timeout path
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OK_TRACE));
    });
  });
}

test("per-probe execution failures are recorded instead of aborting the run", async () => {
  const server = stubServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const side = await collectTraces(baseUrl, "stub", ["ok", "err", "hang"], { timeoutMs: 200 });
    assert.equal(side.traces.ok.status, "complete");
    assert.match(side.probeErrors.err, /HTTP 500/);
    assert.equal(side.traces.err.probeError, side.probeErrors.err);
    assert.match(side.probeErrors.hang, /aborted|AbortError/i);

    // Local side clean, upstream-side failures => drift.
    const clean = { traces: { ok: side.traces.ok, err: side.traces.ok, hang: side.traces.ok }, probeErrors: {} };
    const run = diffRun(side, clean, ["ok", "err", "hang"]);
    assert.equal(run.pass, false);
    assert.deepEqual(Object.keys(run.probeErrors).sort(), ["err", "hang"]);
    assert.ok(run.differences.err, "one-sided error is also a trace difference");
    assert.equal(run.differences.ok ?? null, null);

    // Both sides erroring identically still fails — no evidence produced.
    const same = diffRun(side, side, ["ok", "err", "hang"]);
    assert.equal(same.pass, false);
    assert.deepEqual(Object.keys(same.probeErrors).sort(), ["err", "hang"]);

    // A side that never came up marks every probe as an execution error.
    const down = diffRun(side, { traces: {}, probeErrors: {}, error: "did not become ready" }, ["ok"]);
    assert.equal(down.pass, false);
    assert.match(down.probeErrors.ok["workflows-mbt"], /did not become ready/);
  } finally {
    server.close();
  }
});
