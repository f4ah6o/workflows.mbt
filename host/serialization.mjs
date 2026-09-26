export class SerializationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowSerializationError";
  }
}

function assertJson(value, path, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new SerializationError(`${path} contains a non-finite number`);
    }
    return;
  }
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    throw new SerializationError(`${path} contains unsupported ${type}`);
  }
  if (seen.has(value)) throw new SerializationError(`${path} contains a cycle`);
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new SerializationError(
        `${path} must contain plain JSON objects; ${value.constructor?.name ?? "object"} is unsupported`,
      );
    }
    for (const [key, child] of Object.entries(value)) {
      assertJson(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function serializeJson(value, label = "value") {
  assertJson(value, label, new Set());
  return JSON.stringify(value);
}

// Cloudflare workflows commonly use side-effect-only step.do callbacks. Preserve
// top-level undefined explicitly while still rejecting undefined nested in JSON.
export function encodeDurableValue(value, label = "value") {
  if (value === undefined) return JSON.stringify({ kind: "undefined" });
  return JSON.stringify({ kind: "json", value: JSON.parse(serializeJson(value, label)) });
}

export function decodeDurableValue(text) {
  if (text == null) return undefined;
  const envelope = JSON.parse(text);
  if (envelope?.kind === "undefined") return undefined;
  if (envelope?.kind === "json") return envelope.value;
  throw new SerializationError("Persisted durable value has an unknown encoding");
}

export function serializeError(error) {
  return JSON.stringify({
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
    nonRetryable: Boolean(error?.nonRetryable || error?.name === "NonRetryableError"),
  });
}

export function deserializeError(text) {
  const data = JSON.parse(text);
  const error = new Error(data.message);
  error.name = data.name;
  if (data.stack) error.stack = data.stack;
  if (data.nonRetryable) error.nonRetryable = true;
  return error;
}

export function observableConfig(config) {
  return JSON.stringify(config, (_key, value) =>
    typeof value === "function" ? "[WorkflowDelayFunction]" : value,
  );
}
