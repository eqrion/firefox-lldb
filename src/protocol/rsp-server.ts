/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A generic GDB-remote-serial-protocol TCP server.
//
// Owns socket I/O, packet framing, and ack/no-ack bookkeeping; delegates
// packet payloads to an RspHandler.

import net from "node:net";
import { PacketParser, framePacket } from "./packet.js";
import { noopLogger, type Logger } from "../logging.js";

export interface RspHandler {
  /**
   * Handle one packet payload. Return the response payload (string or raw
   * bytes), an empty string for "unsupported", or null to send no immediate
   * response (e.g. continue/step, whose reply is a later async stop packet).
   */
  handle(payload: Buffer, session: RspSession): Promise<Uint8Array | string | null>;
}

/** @deprecated Import Logger from logging.ts in non-RSP code. */
export type RspLogger = Logger;

/** One client connection. Created by RspServer for each accepted socket. */
export class RspSession {
  #socket: net.Socket;
  #parser = new PacketParser();
  #handler: RspHandler;
  #log: Logger;
  #noAck = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(socket: net.Socket, handler: RspHandler, log: Logger) {
    this.#socket = socket;
    this.#handler = handler;
    this.#log = log;

    socket.on("data", (data: Buffer) => this.#onData(data));
    socket.on("error", (err) => this.#log.warn(`socket error: ${err.message}`));
  }

  setNoAckMode(on: boolean): void {
    this.#noAck = on;
  }

  /** Send a framed packet (used for responses and async notifications). */
  send(payload: Uint8Array | string): void {
    const printable = typeof payload === "string" ? payload : "<binary>";
    this.#log.debug(`>> ${truncate(printable)}`);
    this.#socket.write(framePacket(payload));
  }

  #sendRaw(byte: string): void {
    this.#socket.write(byte);
  }

  #onData(data: Buffer): void {
    // Serialize handling so async handlers reply in packet order.
    // The catch prevents a rejection (e.g. an unexpected parser throw) from
    // permanently breaking the queue and silently dropping all future packets.
    this.#queue = this.#queue
      .then(() => this.#process(data))
      .catch((err) => this.#log.error(`packet processing error: ${(err as Error).message}`));
  }

  async #process(data: Buffer): Promise<void> {
    for (const item of this.#parser.feed(data)) {
      switch (item.type) {
        case "ack":
        case "nack":
          break;
        case "interrupt":
          this.#log.debug("<< interrupt");
          break;
        case "packet": {
          if (!item.valid) {
            this.#log.warn("<< bad checksum");
            if (!this.#noAck) this.#sendRaw("-");
            break;
          }
          if (!this.#noAck) this.#sendRaw("+");
          const text = item.payload.toString("latin1");
          this.#log.debug(`<< ${truncate(text)}`);
          try {
            const response = await this.#handler.handle(item.payload, this);
            if (response !== null) this.send(response);
          } catch (err) {
            this.#log.error(`handler error: ${(err as Error).message}`);
            this.send("E01");
          }
          break;
        }
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** A TCP server that hands each accepted connection to an RspHandler. */
export class RspServer {
  #server: net.Server;
  #log: Logger;
  #port = 0;
  #sockets = new Set<net.Socket>();
  #listening = false;
  #closePromise: Promise<void> | undefined;

  constructor(handler: RspHandler, options: { logger?: Logger; singleConnection?: boolean } = {}) {
    this.#log = options.logger ?? noopLogger;
    let active: RspSession | null = null;

    this.#server = net.createServer((socket) => {
      if (options.singleConnection && active) {
        this.#log.warn("rejecting second connection");
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      this.#log.info("client connected");
      this.#sockets.add(socket);
      const session = new RspSession(socket, handler, this.#log);
      active = session;
      socket.on("close", () => {
        this.#sockets.delete(socket);
        if (active === session) active = null;
        this.#log.info("client disconnected");
      });
    });
    // Persistent error handler so unexpected server errors (e.g. EADDRINUSE
    // on re-bind) are logged rather than crashing via unhandled-error.
    this.#server.on("error", (err) => this.#log.error(`server error: ${err.message}`));
  }

  /** Begin listening. Port 0 auto-selects. Resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        const addr = this.#server.address();
        this.#port = typeof addr === "object" && addr ? addr.port : port;
        this.#listening = true;
        this.#log.info(`listening on ${host}:${this.#port}`);
        resolve(this.#port);
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#listening) return Promise.resolve();
    // Destroy any open client sockets so the close callback fires promptly even
    // if LLDB is still connected. Without this, server.close() would wait
    // indefinitely for LLDB to disconnect voluntarily.
    for (const s of this.#sockets) s.destroy();
    this.#closePromise = new Promise((resolve, reject) =>
      this.#server.close((err) => {
        this.#listening = false;
        if (err) reject(err);
        else resolve();
      })
    );
    return this.#closePromise;
  }
}

function truncate(str: string, max = 200): string {
  return str.length <= max ? str : `${str.slice(0, max)}... (${str.length} chars)`;
}
