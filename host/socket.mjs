// Loopback `connect()` support: a real outbound TCP/TLS socket exposed with
// the Cloudflare `Socket` interface, backed by node:net/node:tls. This mirrors
// `Fetcher.connect` on a service binding — the call opens an outbound socket
// via the runtime and is never delivered to the exported handler object.

import net from "node:net";
import tls from "node:tls";
import { Readable, Writable } from "node:stream";

export class LoopbackSocket {
  #socket;
  #openedResolve;
  #openedReject;

  constructor(socket) {
    this.#socket = socket;
    this.readable = Readable.toWeb(socket);
    this.writable = Writable.toWeb(socket);
    this.secureTransport = socket.encrypted ? "on" : "off";
    this.upgradedToTls = Boolean(socket.encrypted);
    this.opened = new Promise((resolve, reject) => {
      this.#openedResolve = resolve;
      this.#openedReject = reject;
      const onConnect = () => {
        socket.off("error", onError);
        resolve({
          remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`,
          localAddress: `${socket.localAddress}:${socket.localPort}`,
        });
      };
      const onError = (error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      socket.once("secureConnect", onConnect);
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.once("error", () => {});
  }

  async close() {
    this.#socket.destroy();
    await this.closed;
  }

  // Returns a new Socket wrapping the TLS-upgraded connection, per upstream.
  startTls() {
    const secure = tls.connect({
      socket: this.#socket,
      servername: this.#socket.servernameHint,
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
  const socket =
    options?.secureTransport === "on"
      ? tls.connect({ ...socketOptions, servername: hostname })
      : net.connect(socketOptions);
  socket.servernameHint = hostname;
  return new LoopbackSocket(socket);
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
