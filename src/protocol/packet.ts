/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// GDB remote serial protocol packet framing and parsing.
//
// Wire format: $<payload>#<two-hex-digit-checksum>
// Ack mode: receiver sends '+' for a valid packet, '-' for a bad checksum.
// Binary payloads (e.g. vFile:pread data) use the escape byte 0x7d ('}').
//
// This layer is byte-oriented because several platform packets carry raw
// binary data that must not survive a round-trip through a UTF-8 string.

const ESCAPE = 0x7d; // '}'
const ESCAPED_BYTES = new Set([0x23 /* # */, 0x24 /* $ */, 0x2a /* * */, ESCAPE]);

/** GDB checksum: sum of payload bytes modulo 256. */
export function checksum(payload: Uint8Array): number {
  let sum = 0;
  for (const b of payload) {
    sum = (sum + b) & 0xff;
  }
  return sum;
}

function toBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

/** Frame a payload into a complete packet: $<payload>#<checksum>. */
export function framePacket(payload: Uint8Array | string): Buffer {
  const body = toBytes(payload);
  const cs = checksum(body).toString(16).padStart(2, "0");
  return Buffer.concat([Buffer.from("$"), Buffer.from(body), Buffer.from("#"), Buffer.from(cs)]);
}

/** Escape raw bytes for inclusion in a binary packet payload. */
export function escapeBinary(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of data) {
    if (ESCAPED_BYTES.has(b)) {
      out.push(ESCAPE, b ^ 0x20);
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** Reverse escapeBinary for an incoming binary payload (e.g. vFile:pwrite). */
export function unescapeBinary(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === ESCAPE) {
      out.push(data[++i] ^ 0x20);
    } else {
      out.push(data[i]);
    }
  }
  return Uint8Array.from(out);
}

export type ParsedItem =
  | { type: "packet"; payload: Buffer; valid: boolean }
  | { type: "ack" }
  | { type: "nack" }
  | { type: "interrupt" };

const DOLLAR = 0x24;
const HASH = 0x23;
const PLUS = 0x2b;
const MINUS = 0x2d;
const CTRL_C = 0x03;

/** Incremental parser: feed socket bytes, drain complete protocol items. */
export class PacketParser {
  #buffer: Buffer = Buffer.alloc(0);

  feed(data: Buffer): ParsedItem[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, data]) : data;
    const items: ParsedItem[] = [];

    while (this.#buffer.length > 0) {
      const ch = this.#buffer[0];

      if (ch === PLUS) {
        items.push({ type: "ack" });
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      if (ch === MINUS) {
        items.push({ type: "nack" });
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      if (ch === CTRL_C) {
        items.push({ type: "interrupt" });
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }
      if (ch === DOLLAR) {
        const hashIdx = this.#buffer.indexOf(HASH, 1);
        if (hashIdx === -1 || this.#buffer.length < hashIdx + 3) {
          return items; // incomplete; wait for more bytes
        }
        const view = this.#buffer.subarray(1, hashIdx);
        const csHex = this.#buffer.subarray(hashIdx + 1, hashIdx + 3).toString("latin1");
        const valid = parseInt(csHex, 16) === checksum(view);
        const payload = Buffer.allocUnsafe(view.length);
        view.copy(payload);
        items.push({ type: "packet", payload, valid });
        this.#buffer = this.#buffer.subarray(hashIdx + 3);
        continue;
      }

      // Unknown leading byte; skip it.
      this.#buffer = this.#buffer.subarray(1);
    }

    return items;
  }
}
