const STABLE_LIFECYCLE = new Set([
  "workflow_queued",
  "workflow_started",
  "workflow_paused",
  "workflow_waiting_for_pause",
  "workflow_completed",
  "workflow_errored",
  "workflow_terminated",
]);
function errorShape(error) {
  if (!error) return undefined;
  return { name: error.name ?? "Error", message: error.message ?? String(error) };
}

// JSON object key order is not part of the observable contract — Cloudflare
// and workflows.mbt serialize structurally equal values with different member
// ordering (e.g. resolved step config). Sort keys before comparison.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

function appendStep(map, event) {
  if (!event.stepName) return;
  const item = map.get(event.stepName) ?? { name: event.stepName, events: [], attempts: [] };
  item.events.push(event.type);
  if (Number.isInteger(event.attempt)) item.attempts.push(event.attempt);
  if (event.type === "step_completed" && "output" in event) item.output = sortKeysDeep(event.output);
  if (event.error) item.error = errorShape(event.error);
  map.set(event.stepName, item);
}

export function normalizeTrace(raw) {
  const events = Array.isArray(raw.events) ? raw.events : [];
  const steps = new Map();
  const lifecycle = [];
  const rollbackOrder = [];
  const rollbackOutcome = [];
  const wait = [];
  const sleep = [];

  for (const event of events) {
    if (typeof event?.type !== "string") continue;
    if (STABLE_LIFECYCLE.has(event.type)) lifecycle.push(event.type);
    if (event.stepName) appendStep(steps, event);
    if (event.type === "rollback_step_started") rollbackOrder.push(event.stepName);
    if (event.type === "rollback_completed" || event.type === "rollback_errored") {
      rollbackOutcome.push(event.type);
    }
    if (event.type.startsWith("wait_")) {
      wait.push({ type: event.type, stepName: event.stepName, eventType: event.eventType });
    }
    if (event.type.startsWith("sleep_")) {
      sleep.push({ type: event.type, stepName: event.stepName, durationMs: event.durationMs });
    }
  }

  return {
    probe: raw.probe,
    status: raw.status?.status,
    output: sortKeysDeep(raw.status?.output ?? raw.output) ?? undefined,
    error: errorShape(raw.status?.error),
    lifecycle,
    steps: [...steps.values()],
    rollbackOrder,
    rollbackOutcome,
    wait,
    sleep,
  };
}

// durationMs is measured against Date.now() at slightly different instants on
// each runtime (emit-time vs step-start bookkeeping), so sub-100ms jitter is
// nondeterministic and not a semantic difference. Larger gaps still flag.
const DURATION_TOLERANCE_MS = 100;

function normalizedEqual(expected, actual, key) {
  if (key === "durationMs" && typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= DURATION_TOLERANCE_MS;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => normalizedEqual(item, actual[index]))
    );
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((childKey) =>
      normalizedEqual(expected[childKey], actual[childKey], childKey)
    );
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export function diffTrace(expected, actual) {
  if (normalizedEqual(expected, actual)) return null;
  return { expected, actual };
}
