/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Hex and ASCII-hex encoding helpers shared across the GDB-remote layers.

const HEX = "0123456789abcdef";

/** Encode raw bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += HEX[b >> 4] + HEX[b & 0xf];
  }
  return out;
}

/** Decode a hex string into raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** Encode an ASCII/UTF-8 string as a hex string (e.g. "/tmp" -> "2f746d70"). */
export function asciiToHex(str: string): string {
  return bytesToHex(new TextEncoder().encode(str));
}

/** Decode a hex string into a UTF-8 string. */
export function hexToAscii(hex: string): string {
  return new TextDecoder().decode(hexToBytes(hex));
}
