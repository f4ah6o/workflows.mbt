export class SerializationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowSerializationError";
  }
}

const MAX_STRUCTURED_BYTES = 1_048_576;
const typedArrayNames = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);

function encodeNode(value, path, seen) {
  if (value === null) return { t: "null" };
  const type = typeof value;
  if (type === "string" || type === "boolean") return { t: type, v: value };
  if (type === "number") {
    if (Number.isNaN(value)) return { t: "number", v: "NaN" };
    if (value === Infinity) return { t: "number", v: "+Infinity" };
    if (value === -Infinity) return { t: "number", v: "-Infinity" };
    if (Object.is(value, -0)) return { t: "number", v: "-0" };
    return { t: "number", v: value };
  }
  if (type === "bigint") return { t: "bigint", v: value.toString() };
  if (type === "undefined") return { t: "undefined" };
  if (type === "function" || type === "symbol") {
    throw new SerializationError(path + " contains unsupported " + type);
  }

  if (seen.has(value)) throw new SerializationError(path + " contains a cycle");
  seen.add(value);
  try {
    if (value instanceof Date) {
      return { t: "date", v: Number.isNaN(value.getTime()) ? null : value.getTime() };
    }
    if (value instanceof RegExp) {
      return { t: "regexp", source: value.source, flags: value.flags, lastIndex: value.lastIndex };
    }
    if (value instanceof ArrayBuffer) {
      return { t: "arraybuffer", v: Buffer.from(value).toString("base64") };
    }
    if (ArrayBuffer.isView(value)) {
      const name = value.constructor?.name;
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
      if (name === "DataView") return { t: "dataview", v: bytes };
      if (!typedArrayNames.has(name)) {
        throw new SerializationError(path + " contains unsupported typed array " + String(name));
      }
      return { t: "typedarray", n: name, v: bytes };
    }
    if (value instanceof Map) {
      return {
        t: "map",
        v: [...value.entries()].map(([key, child], index) => [
          encodeNode(key, path + ".<map-key-" + index + ">", seen),
          encodeNode(child, path + ".<map-value-" + index + ">", seen),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        t: "set",
        v: [...value.values()].map((child, index) =>
          encodeNode(child, path + ".<set-" + index + ">", seen)
        ),
      };
    }
    if (value instanceof Error) {
      const own = {};
      for (const key of Object.keys(value)) {
        own[key] = encodeNode(value[key], path + "." + key, seen);
      }
      return {
        t: "error",
        n: value.name ?? "Error",
        m: value.message ?? "",
        s: value.stack ?? null,
        c: "cause" in value ? encodeNode(value.cause, path + ".cause", seen) : null,
        p: own,
      };
    }
    if (Array.isArray(value)) {
      return {
        t: "array",
        v: value.map((child, index) => encodeNode(child, path + "[" + index + "]", seen)),
      };
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length) {
      throw new SerializationError(path + " contains symbol-keyed properties");
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new SerializationError(
        path + " contains unsupported " + (value.constructor?.name ?? "object"),
      );
    }
    return {
      t: "object",
      v: Object.entries(value).map(([key, child]) => [
        key,
        encodeNode(child, path + "." + key, seen),
      ]),
    };
  } finally {
    seen.delete(value);
  }
}

function decodeNode(node) {
  switch (node?.t) {
    case "null": return null;
    case "string":
    case "boolean": return node.v;
    case "number":
      if (node.v === "NaN") return NaN;
      if (node.v === "+Infinity") return Infinity;
      if (node.v === "-Infinity") return -Infinity;
      if (node.v === "-0") return -0;
      return node.v;
    case "bigint": return BigInt(node.v);
    case "undefined": return undefined;
    case "date": return new Date(node.v == null ? NaN : node.v);
    case "regexp": {
      const out = new RegExp(node.source, node.flags);
      out.lastIndex = node.lastIndex ?? 0;
      return out;
    }
    case "arraybuffer": {
      const bytes = Buffer.from(node.v, "base64");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case "dataview": {
      const bytes = Buffer.from(node.v, "base64");
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new DataView(buffer);
    }
    case "typedarray": {
      const Ctor = globalThis[node.n];
      if (typeof Ctor !== "function" || !typedArrayNames.has(node.n)) {
        throw new SerializationError("Persisted typed array has unknown constructor " + node.n);
      }
      const bytes = Buffer.from(node.v, "base64");
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new Ctor(buffer);
    }
    case "map": return new Map(node.v.map(([key, value]) => [decodeNode(key), decodeNode(value)]));
    case "set": return new Set(node.v.map(decodeNode));
    case "array": return node.v.map(decodeNode);
    case "object": return Object.fromEntries(node.v.map(([key, value]) => [key, decodeNode(value)]));
    case "error": {
      const error = new Error(node.m, node.c ? { cause: decodeNode(node.c) } : undefined);
      error.name = node.n;
      if (node.s) error.stack = node.s;
      for (const [key, value] of Object.entries(node.p ?? {})) error[key] = decodeNode(value);
      return error;
    }
    default:
      throw new SerializationError("Persisted durable value has an unknown encoding");
  }
}

export function serializeJson(value, label = "value") {
  try {
    return JSON.stringify(value, (_key, child) => {
      if (typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") {
        throw new SerializationError(label + " contains unsupported " + typeof child);
      }
      return child;
    });
  } catch (error) {
    if (error instanceof SerializationError) throw error;
    throw new SerializationError(label + " is not JSON-serializable: " + error.message);
  }
}

export function encodeDurableValue(value, label = "value") {
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    throw new SerializationError(
      label + " is a ReadableStream; persisted byte streams are not yet supported by the SQLite adapter",
    );
  }
  const text = JSON.stringify({ kind: "structured", value: encodeNode(value, label, new Set()) });
  if (Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_BYTES) {
    throw new SerializationError(label + " exceeds Cloudflare's 1 MiB non-stream step-result limit");
  }
  return text;
}

export function decodeDurableValue(text) {
  if (text == null) return undefined;
  const envelope = JSON.parse(text);
  if (envelope?.kind === "undefined") return undefined;
  if (envelope?.kind === "json") return envelope.value;
  if (envelope?.kind === "structured") return decodeNode(envelope.value);
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
    typeof value === "function" ? "[dynamic]" : value,
  );
}
