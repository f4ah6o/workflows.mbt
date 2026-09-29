// Worker thread behind PostgresStorage. The storage contract is synchronous
// (matching better-sqlite3), but `pg` is async — this thread owns the
// connection and event loop; the caller thread blocks on a SharedArrayBuffer
// flag and collects each reply with receiveMessageOnPort.
//
// workerData: { flag: Int32Array(SharedArrayBuffer) }
// First parentPort message transfers the reply MessagePort; every later
// message is { id, op, ... } and gets exactly one { id, ok, ... } reply.
import { parentPort, workerData } from "node:worker_threads";

const { flag } = workerData;
let out = null;
let client = null;

function reply(message) {
  out.postMessage(message);
  Atomics.add(flag, 0, 1);
  Atomics.notify(flag, 0);
}

function describe(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null,
  };
}

parentPort.on("message", (message) => {
  if (message?.port) {
    out = message.port;
    return;
  }
  handle(message).catch((error) => {
    reply({ id: message.id, ok: false, error: describe(error) });
  });
});

async function handle({ id, op, ...rest }) {
  if (op === "connect") {
    let pg;
    try {
      pg = (await import("pg")).default;
    } catch (error) {
      throw new Error(
        'PostgreSQL storage requires the optional "pg" package: npm install pg',
        { cause: error },
      );
    }
    // int8 arrives as a string by default; every integer column here stores
    // ms timestamps or small counters, well inside Number's safe range —
    // returning numbers keeps row shapes identical to the SQLite adapter.
    pg.types.setTypeParser(20, (value) => (value == null ? value : Number(value)));
    client = new pg.Client(rest.connectionString);
    await client.connect();
    reply({ id, ok: true, result: null });
    return;
  }
  if (op === "end") {
    await client?.end();
    reply({ id: id, ok: true, result: null });
    return;
  }
  if (op === "query") {
    const result = await client.query({ text: rest.text, values: rest.values });
    reply({
      id,
      ok: true,
      result: { rows: result.rows, rowCount: result.rowCount },
    });
    return;
  }
  throw new Error(`unknown storage worker op: ${op}`);
}
