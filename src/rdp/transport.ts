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

/** Encode one packet as a `<utf8-byte-length>:<json>` frame. */
export function encodeRdpFrame(packet: object): Buffer {
  const json = Buffer.from(JSON.stringify(packet), "utf8");
  return Buffer.concat([Buffer.from(`${json.length}:`, "utf8"), json]);
}

/**
 * Slice one complete `<utf8-byte-length>:<body>` frame off the front of buf.
 * Returns null if buf doesn't yet hold a full frame (wait for more data);
 * throws on a malformed length prefix or size. Does not parse the body —
 * callers decide how (and whether) to JSON.parse it.
 */
export function sliceRdpFrame(buf: Buffer): { body: string; rest: Buffer } | null {
  const colon = buf.indexOf(0x3a); // ':'
  if (colon === -1) {
    if (buf.length > 20) throw new Error("malformed length prefix");
    return null;
  }
  const len = parseInt(buf.subarray(0, colon).toString("latin1"), 10);
  if (Number.isNaN(len) || len < 0) throw new Error("invalid packet length");
  const start = colon + 1;
  if (buf.length < start + len) return null; // wait for the full body
  const body = buf.subarray(start, start + len).toString("utf8");
  return { body, rest: buf.subarray(start + len) };
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
    trace(">>", JSON.stringify(packet));
    this.#socket.write(encodeRdpFrame(packet));
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      let sliced;
      try {
        sliced = sliceRdpFrame(this.#buffer);
      } catch (err) {
        this.emit("error", err as Error);
        return;
      }
      if (!sliced) return;
      this.#buffer = sliced.rest;
      trace("<<", sliced.body);
      try {
        this.emit("packet", JSON.parse(sliced.body) as RdpPacket);
      } catch (err) {
        this.emit("error", err as Error);
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}
