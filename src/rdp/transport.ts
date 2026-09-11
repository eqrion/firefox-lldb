/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox Remote Debug Protocol transport: length-prefixed JSON packets over a
// TCP socket. Wire format is `<utf8-byte-length>:<json>` (see Firefox
// devtools/shared/transport/packets.js).

import net from "node:net";
import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../diagnostics/logger.js";

export interface RdpPacket {
  from?: string;
  type?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

const MAX_RDP_FRAME_BYTES = 64 * 1024 * 1024;
let nextConnectionId = 1;

function trace(logger: Logger, connection: number, dir: ">>" | "<<", json: string): void {
  const text =
    json.length > 2000 ? `${json.slice(0, 2000)}…(${json.length} characters, truncated)` : json;
  logger.debug(`[rdp] ${dir} connection=${connection} ${text}`);
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
  if (colon > 20) throw new Error("malformed length prefix");
  if (colon === -1) {
    if (buf.length > 20) throw new Error("malformed length prefix");
    return null;
  }
  const prefix = buf.subarray(0, colon).toString("latin1");
  if (!/^\d+$/.test(prefix)) throw new Error("invalid packet length");
  const len = Number(prefix);
  if (!Number.isSafeInteger(len)) throw new Error("invalid packet length");
  if (len > MAX_RDP_FRAME_BYTES) throw new Error(`RDP packet length ${len} exceeds limit`);
  const start = colon + 1;
  if (buf.length < start + len) return null; // wait for the full body
  const body = buf.subarray(start, start + len).toString("utf8");
  return { body, rest: buf.subarray(start + len) };
}

export class RdpTransport extends EventEmitter {
  readonly connectionId = nextConnectionId++;
  #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #storage: Buffer = Buffer.alloc(0);
  #logger: Logger;

  constructor(socket: net.Socket, logger: Logger = noopLogger) {
    super();
    this.#socket = socket;
    this.#logger = logger;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => {
      this.#buffer = this.#storage = Buffer.alloc(0);
      this.emit("close");
    });
    socket.on("error", (err) => this.emit("error", err));
  }

  static connect(
    port: number,
    host = "127.0.0.1",
    logger: Logger = noopLogger,
    signal?: AbortSignal
  ): Promise<RdpTransport> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      // The socket owns the abort subscription for its entire lifetime, including
      // TCP connect and the root greeting before an RDP client is available.
      const socket = net.createConnection({ port, host, signal }, () => {
        socket.setNoDelay(true);
        resolve(new RdpTransport(socket, logger));
      });
      socket.once("error", reject);
    });
  }

  send(packet: RdpPacket): void {
    const json = JSON.stringify(packet);
    const body = Buffer.from(json, "utf8");
    if (
      body.length > MAX_RDP_FRAME_BYTES ||
      this.#socket.writableLength + body.length > MAX_RDP_FRAME_BYTES
    )
      throw new Error("RDP output exceeds 64 MiB limit");
    trace(this.#logger, this.connectionId, ">>", json);
    this.#socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
  }

  #onData(chunk: Buffer): void {
    // Grow geometrically, rather than copying a large ArrayBuffer reply for
    // every TCP fragment. Compact only after consuming a preceding frame.
    const size = this.#buffer.length + chunk.length;
    if (size > this.#storage.length) {
      const storage = Buffer.allocUnsafe(
        Math.max(size, Math.min(MAX_RDP_FRAME_BYTES + 21, Math.max(4096, this.#storage.length * 2)))
      );
      this.#buffer.copy(storage);
      this.#storage = storage;
    } else if (this.#buffer.byteOffset !== this.#storage.byteOffset) {
      this.#buffer.copy(this.#storage);
    }
    chunk.copy(this.#storage, this.#buffer.length);
    this.#buffer = this.#storage.subarray(0, size);
    for (;;) {
      let sliced;
      try {
        sliced = sliceRdpFrame(this.#buffer);
      } catch (err) {
        this.#fatal(err as Error);
        return;
      }
      if (!sliced) {
        if (this.#buffer.length === 0 && this.#storage.length > 1024 * 1024)
          this.#buffer = this.#storage = Buffer.alloc(0);
        return;
      }
      this.#buffer = sliced.rest;
      trace(this.#logger, this.connectionId, "<<", sliced.body);
      try {
        const packet: unknown = JSON.parse(sliced.body);
        if (!packet || typeof packet !== "object" || Array.isArray(packet))
          throw new Error("RDP packet is not an object");
        this.emit("packet", packet as RdpPacket);
      } catch (err) {
        this.#fatal(err as Error);
        return;
      }
    }
  }

  #fatal(err: Error): void {
    // Framing loss is unrecoverable: retaining the buffer would report the same
    // error on every subsequent chunk, and a JSON error means reply correlation
    // can no longer be trusted. Closing also unblocks every pending request.
    this.#buffer = this.#storage = Buffer.alloc(0);
    try {
      this.emit("error", err);
    } finally {
      this.#socket.destroy();
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}
