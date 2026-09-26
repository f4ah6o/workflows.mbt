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

function appendStep(map, event) {
  if (!event.stepName) return;
  const item = map.get(event.stepName) ?? { name: event.stepName, events: [], attempts: [] };
  item.events.push(event.type);
  if (Number.isInteger(event.attempt)) item.attempts.push(event.attempt);
  if (event.type === "step_completed" && "output" in event) item.output = event.output;
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
    output: raw.status?.output ?? undefined,
    error: errorShape(raw.status?.error),
    lifecycle,
    steps: [...steps.values()],
    rollbackOrder,
    rollbackOutcome,
    wait,
    sleep,
  };
}

export function diffTrace(expected, actual) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return null;
  return { expected, actual };
}
