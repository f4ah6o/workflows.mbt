// Shared differential probe client used by run-differential.mjs (pinned/
// latest wrangler dev) and canary.mjs (hosted deploy + local run).
//
// A probe that returns non-2xx, times out, or otherwise fails before
// producing a trace is semantic drift evidence, not a runner crash: the
// failure is recorded per probe in `probeErrors` and mirrored into the trace
// slot as {probeError}, so the result file is written and the difference is
// diffable instead of aborting the run.

import { diffTrace, normalizeTrace } from "./normalize.mjs";

async function runProbeOnce(baseUrl, runtime, probe, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + "/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        probe,
        id: "oracle-" + runtime + "-" + probe + "-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(runtime + "/" + probe + ": HTTP " + response.status + ": " + text);
    return normalizeTrace(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(runtime + "/")) throw error;
    throw new Error(`${runtime}/${probe}: ${error?.name ?? "Error"}: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Runs every probe against one runtime. Never throws for per-probe failures:
// errors land in probeErrors and as {probeError} sentinels in traces so a
// single broken probe cannot erase the whole catalog's evidence.
export async function collectTraces(baseUrl, runtime, probes, { timeoutMs = 90000, log } = {}) {
  const traces = {};
  const probeErrors = {};
  for (const probe of probes) {
    try {
      traces[probe] = await runProbeOnce(baseUrl, runtime, probe, timeoutMs);
      log?.(`[${runtime}] ${probe} done`);
    } catch (error) {
      const message = error?.message ?? String(error);
      probeErrors[probe] = message;
      traces[probe] = { probeError: message };
      log?.(`[${runtime}] ${probe} probe error: ${message}`);
    }
  }
  return { traces, probeErrors };
}

// Merges two sides' results into a comparable outcome. Probes missing from a
// side (e.g. that runtime never came up) are treated as execution errors on
// that side. A probe errored identically on both sides still counts as a
// failure — no semantic evidence was produced.
export function diffRun(upstream, local, probes, { upstreamName = "cloudflare", localName = "workflows-mbt" } = {}) {
  const differences = {};
  const probeErrors = {};
  for (const probe of probes) {
    const expected = upstream.traces?.[probe] ?? { probeError: upstream.error ?? `${upstreamName} runtime unavailable` };
    const actual = local.traces?.[probe] ?? { probeError: local.error ?? `${localName} runtime unavailable` };
    const errors = {};
    if (upstream.probeErrors?.[probe] || expected.probeError) errors[upstreamName] = upstream.probeErrors?.[probe] ?? expected.probeError;
    if (local.probeErrors?.[probe] || actual.probeError) errors[localName] = local.probeErrors?.[probe] ?? actual.probeError;
    if (Object.keys(errors).length > 0) probeErrors[probe] = errors;
    const diff = diffTrace(expected, actual);
    if (diff) differences[probe] = diff;
  }
  return {
    differences,
    probeErrors,
    pass: Object.keys(differences).length === 0 && Object.keys(probeErrors).length === 0,
  };
}
