/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger } from "./logger.js";

type Direction = "client->adapter" | "adapter->client";
type Fields = Record<string, unknown>;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS = 256;

/** Observes DAP without changing or rejecting bytes forwarded to LLDB. */
export class DapTrace {
  readonly #streams: Record<Direction, DapStreamTrace>;
  readonly #pending = new Map<
    string,
    { direction: Direction; seq: number; command: string; started: number }
  >();
  #correlationIncomplete = false;

  constructor(private readonly logger: Logger) {
    this.#streams = {
      "client->adapter": new DapStreamTrace((fields) => this.#record("client->adapter", fields)),
      "adapter->client": new DapStreamTrace((fields) => this.#record("adapter->client", fields)),
    };
  }

  feed(direction: Direction, bytes: Uint8Array): void {
    this.#streams[direction].feed(bytes);
  }

  end(direction: Direction): void {
    this.#streams[direction].end();
  }

  logState(event = "snapshot"): void {
    this.logger.debug(
      `[dap] ${JSON.stringify({
        event,
        correlationIncomplete: this.#correlationIncomplete,
        pendingCount: this.#pending.size,
        pending: [...this.#pending.values()].slice(0, 20).map(({ started, ...request }) => ({
          ...request,
          ageMs: Math.round(performance.now() - started),
        })),
        omittedPending: Math.max(0, this.#pending.size - 20),
        streams: {
          "client->adapter": this.#streams["client->adapter"].state(),
          "adapter->client": this.#streams["adapter->client"].state(),
        },
      })}`
    );
  }

  #record(direction: Direction, fields: Fields): void {
    if (fields.event !== "message") this.#correlationIncomplete = true;
    if (fields.type === "request" && typeof fields.seq === "number") {
      const key = `${direction}:${fields.seq}`;
      if (this.#pending.has(key) || this.#pending.size >= MAX_PENDING_REQUESTS) {
        this.#correlationIncomplete = true;
        // Bound diagnostics even when the peer sends requests without replies.
        if (!this.#pending.has(key)) this.#pending.delete(this.#pending.keys().next().value!);
      }
      this.#pending.set(key, {
        direction,
        seq: fields.seq,
        command: String(fields.command ?? "unknown"),
        started: performance.now(),
      });
    } else if (fields.type === "response" && typeof fields.request_seq === "number") {
      const origin = direction === "client->adapter" ? "adapter->client" : "client->adapter";
      const key = `${origin}:${fields.request_seq}`;
      const request = this.#pending.get(key);
      fields.matchedRequest = request !== undefined;
      if (request) {
        fields.durationMs = Math.round(performance.now() - request.started);
        this.#pending.delete(key);
      }
    }
    this.logger.debug(`[dap] ${JSON.stringify({ direction, ...fields })}`);
  }
}

/** Bounded framing observer; malformed headers disable tracing, not transport. */
class DapStreamTrace {
  #header = Buffer.alloc(MAX_HEADER_BYTES);
  #headerBytes = 0;
  #body?: Buffer;
  #bodyLength?: number;
  #bodyBytes = 0;
  #totalBytes = 0;
  #messages = 0;
  #disabled = false;
  #ended = false;

  constructor(private readonly record: (fields: Fields) => void) {}

  state(): Fields {
    return {
      bytes: this.#totalBytes,
      messages: this.#messages,
      headerBytes: this.#headerBytes,
      bodyBytes: this.#bodyBytes,
      bodyLength: this.#bodyLength,
      disabled: this.#disabled,
      ended: this.#ended,
    };
  }

  feed(data: Uint8Array): void {
    this.#totalBytes += data.length;
    if (this.#disabled || this.#ended) return;
    let offset = 0;
    while (offset < data.length) {
      if (this.#bodyLength === undefined) {
        this.#header[this.#headerBytes++] = data[offset++]!;
        const n = this.#headerBytes;
        if (n >= 4 && this.#header.readUInt32BE(n - 4) === 0x0d0a0d0a) {
          const header = this.#header.toString("ascii", 0, n - 4);
          const lengths = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?=\r\n|$)/gi)];
          const length = lengths.length === 1 ? Number(lengths[0]![1]) : NaN;
          if (!Number.isSafeInteger(length) || length < 0) {
            this.#disable("invalid Content-Length");
            return;
          }
          this.#headerBytes = 0;
          this.#bodyLength = length;
          this.#bodyBytes = 0;
          this.#body = length <= MAX_BODY_BYTES ? Buffer.alloc(length) : undefined;
          if (length > MAX_BODY_BYTES)
            this.record({ event: "body-omitted", bytes: length, limit: MAX_BODY_BYTES });
          if (length === 0) this.#complete();
        } else if (n === MAX_HEADER_BYTES) {
          this.#disable("header exceeds 8192 bytes");
          return;
        }
      } else {
        const count = Math.min(data.length - offset, this.#bodyLength - this.#bodyBytes);
        this.#body?.set(data.subarray(offset, offset + count), this.#bodyBytes);
        this.#bodyBytes += count;
        offset += count;
        if (this.#bodyBytes === this.#bodyLength) this.#complete();
      }
    }
  }

  #disable(reason: string): void {
    this.#disabled = true;
    this.record({ event: "trace-disabled", reason });
  }

  #complete(): void {
    const bytes = this.#bodyLength;
    const body = this.#body;
    this.#messages++;
    this.#body = undefined;
    this.#bodyLength = undefined;
    this.#bodyBytes = 0;
    if (!body) return;
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      this.record({ event: "invalid-json", bytes });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.record({ event: "invalid-message", bytes });
      return;
    }
    const packet = message as Fields;
    const summary: Fields = { event: "message", bytes };
    // Deliberately exclude arguments, bodies, output, paths, and error text.
    for (const key of ["type", "command", "event"] as const) {
      if (typeof packet[key] === "string")
        summary[key === "event" ? "name" : key] = packet[key].slice(0, 80);
    }
    for (const key of ["seq", "request_seq"] as const) {
      if (Number.isSafeInteger(packet[key])) summary[key] = packet[key];
    }
    if (typeof packet.success === "boolean") summary.success = packet.success;
    this.record(summary);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (!this.#disabled && (this.#headerBytes > 0 || this.#bodyLength !== undefined))
      this.record({ event: "truncated-stream", ...this.state() });
    this.#body = undefined;
  }
}
