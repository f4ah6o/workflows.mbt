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

// Sentinels produced by normalizeDurableValue(): Blob/Request/Response hold
// bytes that can only be read asynchronously, so the synchronous encoder sees
// these already-buffered wrappers instead.
class EncodedBlob {
  constructor(bytes, type) {
    this.bytes = bytes;
    this.type = type;
  }
}
class EncodedRequest {
  constructor(url, method, headers, body) {
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.body = body;
  }
}
class EncodedResponse {
  constructor(status, statusText, headers, body) {
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.body = body;
  }
}

function encodeHeadersNode(headers) {
  // entries() already emits every Set-Cookie value as its own pair in undici,
  // so a plain entry list preserves them exactly.
  return { t: "headers", v: [...headers.entries()] };
}

async function bufferedBody(readable, label, path) {
  if (readable.bodyUsed) {
    throw new SerializationError(
      `${path} body is already consumed and cannot be persisted`,
    );
  }
  const clone = readable.clone();
  const bytes = clone.body == null
    ? null
    : Buffer.from(await clone.arrayBuffer());
  return bytes;
}

// Collects asynchronously-readable composite values (Blob, Request,
// Response) into a replacements map of buffered sentinel wrappers so the
// encoder can stay synchronous without mutating the caller's value. Every
// node is also validated here, so streams nested inside a result still fail
// loudly instead of passing through to the encoder's generic rejection.
export async function normalizeDurableValue(value, label = "value") {
  const replacements = new Map();
  const seen = new Set();
  async function walk(node, path) {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    if (node instanceof ReadableStream || node instanceof WritableStream) {
      throw new SerializationError(
        `${path} is a stream; only top-level ReadableStream<Uint8Array> step results can be persisted`,
      );
    }
    if (node instanceof Blob) {
      replacements.set(node, new EncodedBlob(Buffer.from(await node.arrayBuffer()), node.type));
      seen.add(node);
      return;
    }
    if (node instanceof Request) {
      const body = await bufferedBody(node, label, path);
      replacements.set(node, new EncodedRequest(node.url, node.method, node.headers, body));
      seen.add(node);
      return;
    }
    if (node instanceof Response) {
      const body = await bufferedBody(node, label, path);
      replacements.set(node, new EncodedResponse(node.status, node.statusText, node.headers, body));
      seen.add(node);
      return;
    }
    seen.add(node);
    if (node instanceof Date || node instanceof RegExp) return;
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) return;
    if (node instanceof Headers) return;
    if (node instanceof Error) {
      if ("cause" in node && typeof node.cause === "object" && node.cause !== null) {
        await walk(node.cause, `${path}.cause`);
      }
      for (const key of Object.keys(node)) {
        await walk(node[key], `${path}.${key}`);
      }
      return;
    }
    if (node instanceof Map) {
      for (const [key, child] of node.entries()) {
        await walk(key, path + ".<map-key>");
        await walk(child, path + ".<map-value>");
      }
      return;
    }
    if (node instanceof Set) {
      for (const child of node.values()) {
        await walk(child, path + ".<set>");
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        await walk(node[index], `${path}[${index}]`);
      }
      return;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return;
    for (const key of Object.keys(node)) {
      await walk(node[key], `${path}.${key}`);
    }
  }
  await walk(value, label);
  return replacements;
}

// `seen` tracks the ancestor stack, not every visited object: a shared
// reference under different parents encodes twice, while a value that
// reaches one of its own ancestors is a cycle. Cycles surface as TypeError —
// the name Cloudflare's durable serializer reports for a cyclic value — and
// the error stays catchable by workflow code.
function encodeNode(value, path, seen, replacements) {
  const replacement = replacements?.get(value);
  if (replacement !== undefined) value = replacement;
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

  if (seen.has(value)) throw new TypeError(path + " contains a cycle");
  seen.add(value);
  try {
    if (value instanceof EncodedBlob) {
      return { t: "blob", v: value.bytes.toString("base64"), c: value.type };
    }
    if (value instanceof EncodedRequest) {
      return {
        t: "request",
        u: value.url,
        m: value.method,
        h: encodeNode(value.headers, path + ".headers", seen, replacements),
        b: value.body == null ? null : value.body.toString("base64"),
      };
    }
    if (value instanceof EncodedResponse) {
      return {
        t: "response",
        s: value.status,
        t2: value.statusText,
        h: encodeNode(value.headers, path + ".headers", seen, replacements),
        b: value.body == null ? null : value.body.toString("base64"),
      };
    }
    if (value instanceof Headers) return encodeHeadersNode(value);
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
          encodeNode(key, path + ".<map-key-" + index + ">", seen, replacements),
          encodeNode(child, path + ".<map-value-" + index + ">", seen, replacements),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        t: "set",
        v: [...value.values()].map((child, index) =>
          encodeNode(child, path + ".<set-" + index + ">", seen, replacements)
        ),
      };
    }
    if (value instanceof Error) {
      const own = {};
      for (const key of Object.keys(value)) {
        own[key] = encodeNode(value[key], path + "." + key, seen, replacements);
      }
      return {
        t: "error",
        n: value.name ?? "Error",
        m: value.message ?? "",
        s: value.stack ?? null,
        c: "cause" in value ? encodeNode(value.cause, path + ".cause", seen, replacements) : null,
        p: own,
      };
    }
    if (Array.isArray(value)) {
      return {
        t: "array",
        v: value.map((child, index) => encodeNode(child, path + "[" + index + "]", seen, replacements)),
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
        encodeNode(child, path + "." + key, seen, replacements),
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
    case "headers": {
      const headers = new Headers();
      for (const [key, value] of node.v) headers.append(key, value);
      return headers;
    }
    case "blob": {
      const bytes = Buffer.from(node.v, "base64");
      return new Blob([bytes], { type: node.c ?? "" });
    }
    case "request": {
      const headers = decodeNode(node.h);
      const body = node.b == null ? null : Buffer.from(node.b, "base64");
      return new Request(node.u, {
        method: node.m,
        headers,
        ...(body == null ? {} : { body, duplex: "half" }),
      });
    }
    case "response": {
      const headers = decodeNode(node.h);
      const body = node.b == null ? null : Buffer.from(node.b, "base64");
      return new Response(body, {
        status: node.s,
        statusText: node.t2,
        headers,
      });
    }
    case "map": return new Map(node.v.map(([key, value]) => [decodeNode(key), decodeNode(value)]));
    case "set": return new Set(node.v.map(decodeNode));
    case "array": return node.v.map(decodeNode);
    case "object": return Object.fromEntries(node.v.map(([key, value]) => [key, decodeNode(value)]));
    case "error": {
      const error = new Error(node.m, node.c ? { cause: decodeNode(node.c) } : undefined);
      // Non-enumerable name so revived Errors JSON.stringify to {} like
      // upstream's structured-clone round-trip; custom own-properties are
      // intentionally not restored.
      Object.defineProperty(error, "name", {
        value: node.n, writable: true, configurable: true,
      });
      if (node.s) error.stack = node.s;
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

// ctx.openStream(streamId) is provided by the runtime so persisted stream
// envelopes decode into fresh readable streams instead of raw handles.
export function encodeDurableValue(value, label = "value", replacements = null) {
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    throw new SerializationError(
      label + " is a ReadableStream; persist step streams through the runtime",
    );
  }
  const text = JSON.stringify({ kind: "structured", value: encodeNode(value, label, new Set(), replacements) });
  if (Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_BYTES) {
    throw new SerializationError(label + " exceeds Cloudflare's 1 MiB non-stream step-result limit");
  }
  return text;
}

export function decodeDurableValue(text, ctx = null) {
  if (text == null) return undefined;
  const envelope = JSON.parse(text);
  if (envelope?.kind === "undefined") return undefined;
  if (envelope?.kind === "json") return envelope.value;
  if (envelope?.kind === "structured") return decodeNode(envelope.value);
  if (envelope?.kind === "stream") {
    if (ctx?.openStream == null) {
      throw new SerializationError("Persisted stream requires a storage context to decode");
    }
    return ctx.openStream(envelope.streamId);
  }
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
