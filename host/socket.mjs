// Loopback `connect()` support: a real outbound TCP/TLS socket exposed with
// the Cloudflare `Socket` interface, backed by node:net/node:tls. This mirrors
// `Fetcher.connect` on a service binding — the call opens an outbound socket
// via the runtime and is never delivered to the exported handler object.
//
// `readable`/`writable` are custom wrappers (not Readable.toWeb/Writable.toWeb)
// so that `startTls()` can detach the exact stream objects callers already
// hold — pinned workerd performs an in-place takeover, erroring the held
// references — and so that pending writes can be flushed before the TLS
// handshake begins (`writable.flush()` ordering).

import net from "node:net";
import tls from "node:tls";

export class LoopbackSocket {
  #socket;
  #neutered = false;
  #readableErrored = false;
  #writeNeutered;
  #pendingWrites = new Set();
  #readableController;
  #openedResolve;
  #openedReject;
  #closedResolve;
  #ready;

  // `socketOrPromise` may be a promise resolving to a node socket — the
  // startTls() path defers `tls.connect` until pending writes flush.
  constructor(socketOrPromise, { secureTransport } = {}) {
    this.secureTransport = secureTransport;
    // `upgraded` is false for every socket — including the TLS socket returned
    // by startTls() — and flips to true on the ORIGINAL socket when startTls()
    // upgrades it (pinned workerd Socket semantics).
    this.upgraded = false;
    this.protocol = "tcp";
    this.opened = new Promise((resolve, reject) => {
      this.#openedResolve = resolve;
      this.#openedReject = reject;
    });
    this.closed = new Promise((resolve) => {
      this.#closedResolve = resolve;
    });
    this.#ready = Promise.resolve(socketOrPromise).then(
      (socket) => {
        this.#socket = socket;
        this.secureTransport = socket.encrypted
          ? "on"
          : secureTransport ?? "off";
        this.#attach(socket);
        return socket;
      },
      (error) => {
        this.#openedReject(error);
        this.#closedResolve();
        throw error;
      },
    );
    this.#ready.catch(() => {});

    // Custom stream wrappers: held references must become unusable on
    // startTls() without destroying the underlying transport, which
    // Readable/Writable.toWeb cannot express (their cancel() would destroy
    // the socket being upgraded).
    this.readable = new ReadableStream({
      start: (controller) => {
        this.#readableController = controller;
      },
      pull: () => {
        this.#socket?.resume();
      },
      cancel: () => {
        if (!this.#neutered) this.#socket?.destroy();
      },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        // Neuter is checked only on entry: a write issued before startTls()
        // is already in flight and must flush before the handshake begins.
        if (this.#writeNeutered) throw this.#writeNeutered;
        const socket = await this.#ready;
        const pending = new Promise((resolve, reject) =>
          socket.write(chunk, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        this.#pendingWrites.add(pending);
        try {
          await pending;
        } finally {
          this.#pendingWrites.delete(pending);
        }
      },
      close: async () => {
        if (this.#writeNeutered) throw this.#writeNeutered;
        const socket = await this.#ready;
        socket.end();
      },
      abort: async (reason) => {
        if (this.#writeNeutered) throw this.#writeNeutered;
        const socket = await this.#ready.catch(() => null);
        socket?.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  }

  #attach(socket) {
    // `opened` resolves only once the connection attempt represented by the
    // selected transport succeeds: plain TCP sockets on `connect`, TLS
    // sockets on `secureConnect` (after certificate/handshake validation).
    const readyEvent = socket.encrypted ? "secureConnect" : "connect";
    const onReady = () => {
      socket.off("error", onError);
      this.#openedResolve({
        remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`,
        localAddress: `${socket.localAddress}:${socket.localPort}`,
      });
    };
    const onError = (error) => {
      socket.off(readyEvent, onReady);
      this.#openedReject(error);
    };
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
    socket.once("close", () => this.#closedResolve());
    socket.once("error", () => {});

    socket.on("data", (chunk) => {
      if (this.#readableErrored) return;
      this.#readableController.enqueue(chunk);
      if (this.#readableController.desiredSize <= 0) socket.pause();
    });
    socket.on("end", () => {
      if (!this.#readableErrored) {
        this.#readableErrored = true;
        this.#readableController.close();
      }
    });
    socket.on("error", (error) => {
      if (!this.#readableErrored) {
        this.#readableErrored = true;
        this.#readableController.error(error);
      }
    });
  }

  async close() {
    if (!this.#neutered) (await this.#ready.catch(() => null))?.destroy();
    await this.closed;
  }

  // Returns a new Socket wrapping the TLS-upgraded connection, per upstream.
  // Only allowed once, on sockets opened with `secureTransport: "starttls"`;
  // pending writes flush before the handshake starts and the original
  // socket's readable/writable objects are detached (errored) in place.
  startTls(options = {}) {
    if (this.#neutered) {
      throw new TypeError("startTls has already been called on this socket");
    }
    if (this.secureTransport !== "starttls") {
      throw new TypeError(
        "startTls() is only allowed when the socket was created with " +
          `secureTransport "starttls" (got "${this.secureTransport}")`,
      );
    }
    this.#neutered = true;
    this.upgraded = true;
    // Detach the original stream objects: any previously held reference to
    // this.readable errors, and writes through this.writable throw — without
    // destroying the underlying transport the new socket takes over.
    const reason = new TypeError("socket was detached by startTls()");
    this.#writeNeutered = reason;
    if (!this.#readableErrored) {
      this.#readableErrored = true;
      this.#readableController?.error(reason);
    }
    this.#closedResolve();
    const upgradedSocket = this.#ready.then((socket) => {
      socket.pause();
      // Flush pending writes before the handshake begins.
      return Promise.all([...this.#pendingWrites]).then(() =>
        tls.connect({
          socket,
          servername:
            options.expectedServerHostname ?? socket.servernameHint,
        }),
      );
    });
    return new LoopbackSocket(upgradedSocket, { secureTransport: "on" });
  }
}

export function connectSocket(address, options = {}) {
  const { hostname, port } =
    typeof address === "string" ? parseAddress(address) : address;
  const socketOptions = { host: hostname, port: Number(port) };
  if (options?.allowHalfOpen != null) {
    socketOptions.allowHalfOpen = options.allowHalfOpen;
  }
  const secureTransport = options?.secureTransport ?? "off";
  const socket =
    secureTransport === "on"
      ? tls.connect({ ...socketOptions, servername: hostname })
      : net.connect(socketOptions);
  socket.servernameHint = hostname;
  return new LoopbackSocket(socket, { secureTransport });
}

function parseAddress(address) {
  const ipv6 = address.match(/^\[(.+)]:(\d+)$/);
  if (ipv6) return { hostname: ipv6[1], port: ipv6[2] };
  const index = address.lastIndexOf(":");
  if (index === -1) {
    throw new Error(`connect() address must be host:port, got ${address}`);
  }
  return { hostname: address.slice(0, index), port: address.slice(index + 1) };
}
