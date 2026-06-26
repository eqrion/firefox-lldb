/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes, asciiToHex, hexToAscii } from "../../src/protocol/hex.js";

test("bytesToHex encodes all bytes as two lowercase hex digits", () => {
  assert.equal(bytesToHex(new Uint8Array([0x00, 0x0f, 0x10, 0xff, 0xab])), "000f10ffab");
});

test("hexToBytes decodes hex pairs into bytes", () => {
  const bytes = hexToBytes("000f10ffab");
  assert.deepEqual(Array.from(bytes), [0x00, 0x0f, 0x10, 0xff, 0xab]);
});

test("bytesToHex / hexToBytes round-trip", () => {
  const original = new Uint8Array([0, 1, 127, 128, 255]);
  assert.deepEqual(Array.from(hexToBytes(bytesToHex(original))), Array.from(original));
});

test("hexToBytes ignores trailing nibble on odd-length input", () => {
  // "abc" → only parse "ab" (1 byte = 0xab), ignore "c"
  const bytes = hexToBytes("abc");
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0xab);
});

test("asciiToHex encodes ASCII string to hex", () => {
  assert.equal(asciiToHex("/tmp"), "2f746d70");
});

test("hexToAscii decodes hex to UTF-8 string", () => {
  assert.equal(hexToAscii("2f746d70"), "/tmp");
});

test("asciiToHex / hexToAscii round-trip with various characters", () => {
  const str = "Hello, World! é";
  assert.equal(hexToAscii(asciiToHex(str)), str);
});

test("bytesToHex produces lowercase only", () => {
  const hex = bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]));
  assert.equal(hex, hex.toLowerCase());
  assert.doesNotMatch(hex, /[A-F]/);
});
