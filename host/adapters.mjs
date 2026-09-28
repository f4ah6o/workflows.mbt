import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

// Optional local adapters for Cloudflare binding families, configured via
// workflows.mbt.json:
//   { "adapters": {
//       "queues":   { "<BINDING>": "loopback" | "spool" },
//       "services": { "<BINDING>": "http://localhost:PORT" }
//   } }
// Declared bindings (kv_namespaces, d1_databases, r2_buckets, queues.producers,
// services) resolve to these local implementations; undeclared modes fail
// loudly instead of silently dropping data.

function now() {
  return new Date();
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ── KV ────────────────────────────────────────────────────────────────────
// One JSON document per namespace under adapters/kv/<binding>.json.
// Values are stored base64 so every KV write type round-trips.

export class LocalKVNamespace {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    const stored = readJsonFile(filePath, {});
    this.entries = new Map(Object.entries(stored));
  }

  #persist() {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
    renameSync(tmp, this.filePath);
  }

  #lookup(key) {
    const entry = this.entries.get(key);
    if (entry == null) return null;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.#persist();
      return null;
    }
    return entry;
  }

  async get(key, options) {
    if (key == null) return null;
    const entry = this.#lookup(key);
    if (entry == null) return null;
    const type = typeof options === "string" ? options : (options?.type ?? "text");
    const bytes = Buffer.from(entry.value, "base64");
    switch (type) {
      case "text": return bytes.toString("utf8");
      case "json": return JSON.parse(bytes.toString("utf8"));
      case "arrayBuffer": return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      case "stream": return new Response(bytes).body;
      case "bytes": return new Uint8Array(bytes);
      default: throw new Error(`LocalKVNamespace: unknown get() type "${type}"`);
    }
  }

  async getWithMetadata(key, options) {
    const value = await this.get(key, options);
    if (value == null) return { value: null, metadata: null };
    return { value, metadata: this.#lookup(key)?.metadata ?? null };
  }

  async put(key, value, options = {}) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("LocalKVNamespace: key must be a non-empty string");
    }
    let bytes;
    if (typeof value === "string") bytes = Buffer.from(value, "utf8");
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) {
      bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else if (value instanceof ReadableStream) {
      bytes = Buffer.from(await new Response(value).arrayBuffer());
    } else {
      throw new Error("LocalKVNamespace: put() value must be string, ArrayBuffer, TypedArray, or ReadableStream");
    }
    const expiresAt = options.expiration != null
      ? options.expiration * 1000
      : options.expirationTtl != null
        ? Date.now() + options.expirationTtl * 1000
        : null;
    this.entries.set(key, {
      value: bytes.toString("base64"),
      metadata: options.metadata ?? null,
      expiresAt,
    });
    this.#persist();
  }

  async delete(key) {
    this.entries.delete(key);
    this.#persist();
  }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const keys = [...this.entries.keys()]
      .filter((key) => this.#lookup(key) != null)
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = cursor == null ? 0 : keys.indexOf(String(cursor)) + 1;
    const page = keys.slice(start, start + limit);
    const truncated = start + page.length < keys.length;
    return {
      keys: page.map((name) => ({
        name,
        ...(this.entries.get(name).metadata == null
          ? {}
          : { metadata: this.entries.get(name).metadata }),
      })),
      list_complete: !truncated,
      cursor: truncated ? page.at(-1) : undefined,
      cacheStatus: null,
    };
  }
}

// ── D1 ────────────────────────────────────────────────────────────────────
// Each binding maps to a real SQLite file, so D1 SQL semantics (types,
// transactions via batch()) are exercised against an actual engine.

class LocalD1PreparedStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new LocalD1PreparedStatement(this.db, this.sql, args);
  }

  async first(columnName = null) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (row == null) return null;
    return columnName == null ? row : (row[columnName] ?? null);
  }

  async run() {
    const started = Date.now();
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: {
        duration: Date.now() - started,
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        rows_read: info.changes,
        rows_written: info.changes,
      },
      results: [],
    };
  }

  async all() {
    const started = Date.now();
    const results = this.db.prepare(this.sql).all(...this.args);
    return {
      success: true,
      meta: {
        duration: Date.now() - started,
        changes: 0,
        last_row_id: 0,
        rows_read: results.length,
        rows_written: 0,
      },
      results,
    };
  }

  async raw() {
    return this.db.prepare(this.sql).raw().all(...this.args);
  }
}

export class LocalD1Database {
  constructor(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  prepare(sql) {
    return new LocalD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    // D1 batch() is all-or-nothing — a real transaction.
    const started = Date.now();
    const results = this.db.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof LocalD1PreparedStatement)) {
          throw new Error("LocalD1Database.batch() expects statements from prepare()");
        }
        const info = /^\s*select/i.test(statement.sql)
          ? { rows: statement.db.prepare(statement.sql).all(...statement.args) }
          : { info: statement.db.prepare(statement.sql).run(...statement.args) };
        if ("rows" in info) {
          return {
            success: true,
            results: info.rows,
            meta: { duration: 0, changes: 0, last_row_id: 0, rows_read: info.rows.length, rows_written: 0 },
          };
        }
        return {
          success: true,
          results: [],
          meta: {
            duration: 0,
            changes: info.info.changes,
            last_row_id: Number(info.info.lastInsertRowid),
            rows_read: info.info.changes,
            rows_written: info.info.changes,
          },
        };
      }),
    )();
    void started;
    return results;
  }

  async exec(sql) {
    const started = Date.now();
    this.db.exec(sql);
    return { count: 1, duration: Date.now() - started };
  }

  async dump() {
    throw new Error("LocalD1Database.dump() is not implemented by the local adapter");
  }

  withSession() {
    return {
      prepare: (sql) => this.prepare(sql),
      batch: (stmts) => this.batch(stmts),
      exec: (sql) => this.exec(sql),
    };
  }
}

// ── R2 ────────────────────────────────────────────────────────────────────
// Objects live under adapters/r2/<binding>/<urlencoded key> with a sibling
// .meta.json carrying HTTP/custom metadata.

class LocalR2Object {
  constructor(bucket, key, stat, meta = {}) {
    this.bucket = bucket;
    this.key = key;
    this.version = String(stat.mtimeMs);
    this.size = stat.size;
    this.etag = `"${stat.size}-${stat.mtimeMs}"`;
    this.httpEtag = this.etag;
    this.checksums = {};
    this.uploaded = stat.mtime;
    this.httpMetadata = meta.httpMetadata ?? {};
    this.customMetadata = meta.customMetadata ?? {};
    this.range = undefined;
    this.storageClass = "Standard";
  }

  get dataPath() {
    return this.bucket.pathFor(this.key);
  }

  async arrayBuffer() {
    const buffer = readFileSync(this.dataPath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text() {
    return readFileSync(this.dataPath, "utf8");
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async blob() {
    return new Blob([await this.arrayBuffer()]);
  }
}

class LocalR2ObjectBody extends LocalR2Object {
  get body() {
    return new Response(readFileSync(this.dataPath)).body;
  }

  get bodyUsed() {
    return false;
  }
}

export class LocalR2Bucket {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  pathFor(key) {
    const path = resolve(this.dir, key.split("/").map(encodeURIComponent).join("/"));
    if (!path.startsWith(resolve(this.dir))) {
      throw new Error("LocalR2Bucket: key escapes the bucket directory");
    }
    return path;
  }

  async put(key, value, options = {}) {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    let bytes;
    if (typeof value === "string") bytes = Buffer.from(value, "utf8");
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof ReadableStream) bytes = Buffer.from(await new Response(value).arrayBuffer());
    else if (value instanceof Blob) bytes = Buffer.from(await value.arrayBuffer());
    else if (value == null) bytes = Buffer.alloc(0);
    else throw new Error("LocalR2Bucket.put(): unsupported value type");
    writeFileSync(path, bytes);
    writeFileSync(`${path}.meta.json`, JSON.stringify({
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    }));
    return new LocalR2Object(this, key, statSync(path), readJsonFile(`${path}.meta.json`, {}));
  }

  #read(key) {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    return { stat: statSync(path), meta: readJsonFile(`${path}.meta.json`, {}) };
  }

  async get(key) {
    const found = this.#read(key);
    return found == null ? null : new LocalR2ObjectBody(this, key, found.stat, found.meta);
  }

  async head(key) {
    const found = this.#read(key);
    return found == null ? null : new LocalR2Object(this, key, found.stat, found.meta);
  }

  async delete(keys) {
    for (const key of [keys].flat()) {
      const path = this.pathFor(key);
      try {
        unlinkSync(path);
        unlinkSync(`${path}.meta.json`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async list({ prefix = "", limit = 1000, cursor, delimiter } = {}) {
    const objects = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (!entry.name.endsWith(".meta.json")) objects.push(join(dir, entry.name));
      }
    };
    walk(this.dir);
    const keys = objects
      .map((path) => path.slice(resolve(this.dir).length + 1).split("/").map(decodeURIComponent).join("/"))
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = cursor == null ? 0 : keys.indexOf(String(cursor)) + 1;
    const page = keys.slice(start, start + limit);
    const delimited = new Set();
    const listed = delimiter == null
      ? page
      : page.filter((key) => {
          const rest = key.slice(prefix.length);
          const idx = rest.indexOf(delimiter);
          if (idx === -1) return true;
          delimited.add(prefix + rest.slice(0, idx + 1));
          return false;
        });
    const truncated = start + page.length < keys.length;
    return {
      objects: listed.map((key) => {
        const { stat, meta } = this.#read(key);
        return new LocalR2Object(this, key, stat, meta);
      }),
      delimitedPrefixes: [...delimited],
      truncated,
      cursor: truncated ? page.at(-1) : undefined,
    };
  }

  async createMultipartUpload() {
    throw new Error("LocalR2Bucket multipart uploads are not implemented by the local adapter");
  }
}

// ── Queues ────────────────────────────────────────────────────────────────
// "loopback" (default) delivers to the module's `queue` handler through the
// real batch shape; "spool" appends JSONL under adapters/queues/ for
// inspection when no handler exists.

function queueContentType(value, declared) {
  if (declared != null) return declared;
  if (typeof value === "string") return "text";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "bytes";
  return "json";
}

export class LocalQueueProducer {
  constructor({ binding, queue, mode = "loopback", spoolPath, invoke }) {
    this.binding = binding;
    this.queue = queue;
    this.mode = mode;
    this.spoolPath = spoolPath;
    this.invoke = invoke;
  }

  #serialize(body, declaredContentType) {
    const contentType = queueContentType(body, declaredContentType);
    switch (contentType) {
      case "text": return { contentType, body: String(body) };
      case "bytes": {
        const bytes = body instanceof ArrayBuffer
          ? Buffer.from(body)
          : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        return { contentType, body: bytes.toString("base64") };
      }
      case "v8":
        throw new Error("LocalQueueProducer: contentType \"v8\" is not supported by the local adapter");
      default: return { contentType: "json", body };
    }
  }

  #deliverBatch(bodies) {
    const acked = [];
    const retried = [];
    const messages = bodies.map(({ body, contentType }, index) => ({
      id: `local_${index}_${Date.now()}`,
      timestamp: now(),
      body,
      contentType,
      attempts: 1,
      ack() { acked.push(this.id); },
      retry(options = {}) { retried.push({ id: this.id, delaySeconds: options.delaySeconds ?? null }); },
    }));
    const batch = {
      queue: this.queue,
      messages,
      ackAll() { for (const message of messages) message.ack(); },
      retryAll(options = {}) { for (const message of messages) message.retry(options); },
    };
    return batch;
  }

  async #deliver(serialized) {
    const batch = this.#deliverBatch(serialized);
    if (this.mode === "spool") {
      mkdirSync(dirname(this.spoolPath), { recursive: true });
      appendFileSync(this.spoolPath, `${JSON.stringify({ queue: this.queue, messages: serialized })}\n`);
      return;
    }
    await this.invoke(batch);
  }

  async send(body, options = {}) {
    await this.#deliver([this.#serialize(body, options.contentType)]);
  }

  async sendBatch(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError("sendBatch() requires a non-empty array");
    }
    if (messages.length > 100) {
      throw new RangeError("sendBatch() is limited to 100 messages");
    }
    await this.#deliver(
      messages.map((message) => this.#serialize(message.body, message.contentType ?? options.contentType)),
    );
  }
}

// ── Service bindings ──────────────────────────────────────────────────────
// A binding configured with a URL is an HTTP fetch through to that service,
// matching `env.SERVICE.fetch(...)` in workerd.

export class LocalServiceBinding {
  constructor({ binding, url }) {
    this.binding = binding;
    this.url = url.endsWith("/") ? url.slice(0, -1) : url;
  }

  async fetch(input, init) {
    const sourceUrl = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    const source = new URL(sourceUrl, this.url);
    const rebased = new URL(`${source.pathname}${source.search}`, this.url);
    return fetch(input instanceof Request
      ? new Request(rebased, input)
      : new Request(rebased, init));
  }

  async connect() {
    throw new Error(`LocalServiceBinding ${this.binding}: connect() is not supported by the local adapter`);
  }
}

// ── Assembly ──────────────────────────────────────────────────────────────

export function adaptersDirFor(config) {
  const base = config.storagePath === ":memory:"
    ? resolve(config.root, ".workflows")
    : dirname(config.storagePath);
  return join(base, "adapters");
}

export function buildLocalAdapters(config, { invokeQueue } = {}) {
  const dir = adaptersDirFor(config);
  const adapters = {};
  const queueModes = config.localAdapters?.queues ?? {};
  const services = config.localAdapters?.services ?? {};

  for (const { binding } of config.kvNamespaces ?? []) {
    adapters[binding] ??= new LocalKVNamespace(join(dir, "kv", `${binding}.json`));
  }
  for (const { binding, database_name } of config.d1Databases ?? []) {
    adapters[binding] ??= new LocalD1Database(
      join(dir, "d1", `${database_name ?? binding}.sqlite`),
    );
  }
  for (const { binding, bucket_name } of config.r2Buckets ?? []) {
    adapters[binding] ??= new LocalR2Bucket(join(dir, "r2", bucket_name ?? binding));
  }
  for (const { binding, queue } of config.queueProducers ?? []) {
    const mode = queueModes[binding] ?? "loopback";
    if (mode !== "loopback" && mode !== "spool") {
      throw new Error(
        `Queue producer "${binding}": unknown adapter mode "${mode}" (expected "loopback" or "spool")`,
      );
    }
    adapters[binding] ??= new LocalQueueProducer({
      binding,
      queue,
      mode,
      spoolPath: join(dir, "queues", `${binding}.jsonl`),
      invoke: async (batch) => {
        if (typeof invokeQueue !== "function") {
          throw new Error(
            `Queue producer "${binding}": no queue handler to invoke (set local.adapters.queues.${binding} = "spool" to record deliveries instead)`,
          );
        }
        await invokeQueue(batch);
      },
    });
  }
  for (const { binding } of config.serviceBindings ?? []) {
    const url = services[binding];
    if (url == null) {
      throw new Error(
        `Service binding "${binding}" requires local.adapters.services.${binding} to be an HTTP URL (remote service bindings are not emulated)`,
      );
    }
    adapters[binding] ??= new LocalServiceBinding({ binding, url });
  }
  return adapters;
}
