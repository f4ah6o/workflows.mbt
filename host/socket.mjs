// Loopback `connect()` support: a real outbound TCP/TLS socket exposed with
// the Cloudflare `Socket` interface, backed by node:net/node:tls. This mirrors
// `Fetcher.connect` on a service binding — the call opens an outbound socket
// via the runtime and is never delivered to the exported handler object.

import net from "node:net";
import tls from "node:tls";
import { Readable, Writable } from "node:stream";

export class LoopbackSocket {
  #socket;
  #neutered = false;
  #closedResolve;

  constructor(socket, { secureTransport } = {}) {
    this.#socket = socket;
    this.secureTransport = socket.encrypted ? "on" : secureTransport ?? "off";
    // `upgraded` is false for every socket — including the TLS socket returned
    // by startTls() — and flips to true on the ORIGINAL socket when startTls()
    // upgrades it (pinned workerd Socket semantics).
    this.upgraded = false;
    this.protocol = "tcp";
    this.readable = Readable.toWeb(socket);
    this.writable = Writable.toWeb(socket);
    this.opened = new Promise((resolve, reject) => {
      // `opened` resolves only once the connection attempt represented by the
      // selected transport succeeds: plain TCP sockets on `connect`, TLS
      // sockets on `secureConnect` (after certificate/handshake validation).
      const readyEvent = socket.encrypted ? "secureConnect" : "connect";
      const onReady = () => {
        socket.off("error", onError);
        resolve({
          remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`,
          localAddress: `${socket.localAddress}:${socket.localPort}`,
        });
      };
      const onError = (error) => {
        socket.off(readyEvent, onReady);
        reject(error);
      };
      socket.once(readyEvent, onReady);
      socket.once("error", onError);
    });
    this.closed = new Promise((resolve) => {
      this.#closedResolve = resolve;
      socket.once("close", () => resolve());
    });
    socket.once("error", () => {});
  }

  async close() {
    if (!this.#neutered) this.#socket.destroy();
    await this.closed;
  }

  // Returns a new Socket wrapping the TLS-upgraded connection, per upstream.
  // Only allowed on sockets opened with `secureTransport: "starttls"`; the
  // original socket's streams are neutered by the upgrade.
  startTls(options = {}) {
    if (this.secureTransport !== "starttls") {
      throw new TypeError(
        "startTls() is only allowed when the socket was created with " +
          `secureTransport "starttls" (got "${this.secureTransport}")`,
      );
    }
    this.#neutered = true;
    this.upgraded = true;
    // Neuter the original socket's streams — erroring them (not cancelling)
    // keeps the underlying transport alive for the TLS upgrade while making
    // the old Socket observably unusable.
    const reason = new TypeError("socket was neutered by startTls()");
    this.readable = new ReadableStream({
      start(controller) {
        controller.error(reason);
      },
    });
    this.writable = new WritableStream({
      start(controller) {
        controller.error(reason);
      },
    });
    this.#closedResolve();
    this.#socket.pause();
    const secure = tls.connect({
      socket: this.#socket,
      servername:
        options.expectedServerHostname ?? this.#socket.servernameHint,
    });
    return new LoopbackSocket(secure);
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
