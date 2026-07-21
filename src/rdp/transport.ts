/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox Remote Debug Protocol transport: length-prefixed JSON packets over a
// TCP socket. Wire format is `<utf8-byte-length>:<json>` (see Firefox
// devtools/shared/transport/packets.js).

import net from "node:net";
import { EventEmitter } from "node:events";
import { noopLogger, type RspLogger } from "../protocol/rsp-server.js";

export interface RdpPacket {
  from?: string;
  type?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

// Process-wide RDP wire trace sink. debug() is a no-op on the default
// noopLogger, so this stays silent until the server wires up a real logger
// (its debug() is itself gated behind `-v`/DEBUG=1 — see cli/logger.ts).
let rdpLogger: RspLogger = noopLogger;
export function setRdpLogger(logger: RspLogger): void {
  rdpLogger = logger;
}

function trace(dir: ">>" | "<<", json: string): void {
  const text = json.length > 2000 ? `${json.slice(0, 2000)}…(${json.length} bytes)` : json;
  rdpLogger.debug(`[rdp] ${dir} ${text}`);
}

export class RdpTransport extends EventEmitter {
  #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(socket: net.Socket) {
    super();
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }

  static connect(port: number, host = "127.0.0.1"): Promise<RdpTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => {
        socket.setNoDelay(true);
        resolve(new RdpTransport(socket));
      });
      socket.once("error", reject);
    });
  }

  send(packet: RdpPacket): void {
    const body = JSON.stringify(packet);
    trace(">>", body);
    const json = Buffer.from(body, "utf8");
    this.#socket.write(`${json.length}:`);
    this.#socket.write(json);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a); // ':'
      if (colon === -1) {
        if (this.#buffer.length > 20) this.emit("error", new Error("malformed length prefix"));
        return;
      }
      const len = parseInt(this.#buffer.subarray(0, colon).toString("latin1"), 10);
      if (Number.isNaN(len) || len < 0) {
        this.emit("error", new Error("invalid packet length"));
        return;
      }
      const start = colon + 1;
      if (this.#buffer.length < start + len) return; // wait for the full body
      const body = this.#buffer.subarray(start, start + len).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + len);
      trace("<<", body);
      try {
        this.emit("packet", JSON.parse(body) as RdpPacket);
      } catch (err) {
        this.emit("error", err as Error);
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}
