/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Streaming diagnostics only: never retains a full packet or changes traffic. */
export class RspTrace {
  lastPacket = "none";
  #phase: "idle" | "payload" | "checksum" = "idle";
  #escaped = false;
  #preview = "";
  #bytes = 0;
  #checksum = "";

  constructor(private readonly record: (summary: string) => void) {}

  feed(data: Uint8Array): void {
    for (const byte of data) {
      if (this.#phase === "idle") {
        if (byte === 0x24) {
          this.#phase = "payload";
          this.#preview = "";
          this.#bytes = 0;
          this.#escaped = false;
        }
      } else if (this.#phase === "payload") {
        if (!this.#escaped && byte === 0x23) {
          this.#phase = "checksum";
          this.#checksum = "";
          continue;
        }
        this.#bytes++;
        if (this.#preview.length < 160)
          this.#preview += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
        this.#escaped = !this.#escaped && byte === 0x7d;
      } else {
        this.#checksum += String.fromCharCode(byte);
        if (this.#checksum.length === 2) {
          const truncated = this.#bytes > 160 ? `… (${this.#bytes} byte payload)` : "";
          this.lastPacket = `$${this.#preview}${truncated}#${this.#checksum}`;
          this.record(this.lastPacket);
          this.#phase = "idle";
        }
      }
    }
  }
}
