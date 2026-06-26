/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unit tests for the SAB-RPC wire codec (src/gdb/worker/wire.mjs).
// The codec serialises structured values (including Uint8Array blobs and BigInt)
// into a flat Uint8Array that can be written to a SharedArrayBuffer.

import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — .mjs file has no type declarations
import { encode, decode } from "../../src/gdb/worker/wire.mjs";

function roundTrip(value: unknown): unknown {
  const encoded = encode(value);
  return decode(encoded);
}

test("encode/decode round-trips null", () => {
  assert.strictEqual(roundTrip(null), null);
});

test("encode/decode round-trips undefined as null", () => {
  // collect() maps undefined → null
  assert.strictEqual(roundTrip(undefined), null);
});

test("encode/decode round-trips numbers", () => {
  assert.strictEqual(roundTrip(0), 0);
  assert.strictEqual(roundTrip(42), 42);
  assert.strictEqual(roundTrip(-1.5), -1.5);
  assert.strictEqual(roundTrip(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("encode/decode round-trips strings", () => {
  assert.strictEqual(roundTrip(""), "");
  assert.strictEqual(roundTrip("hello world"), "hello world");
  assert.strictEqual(roundTrip("日本語"), "日本語");
});

test("encode/decode round-trips booleans", () => {
  assert.strictEqual(roundTrip(true), true);
  assert.strictEqual(roundTrip(false), false);
});

test("encode/decode round-trips BigInt as {$big} ref", () => {
  assert.strictEqual(roundTrip(42n), 42n);
  assert.strictEqual(roundTrip(BigInt("9007199254740993")), 9007199254740993n);
});

test("encode/decode round-trips plain objects", () => {
  const obj = { a: 1, b: "two", c: null };
  assert.deepEqual(roundTrip(obj), obj);
});

test("encode/decode round-trips arrays", () => {
  assert.deepEqual(roundTrip([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(roundTrip([null, "x", 99n]), [null, "x", 99n]);
});

test("encode/decode round-trips Uint8Array blobs via {$bin} ref", () => {
  const blob = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
  const result = roundTrip(blob) as Uint8Array;
  assert.ok(result instanceof Uint8Array, "result should be Uint8Array");
  assert.deepEqual(Array.from(result), Array.from(blob));
});

test("encode/decode handles nested blobs and bigints together", () => {
  const value = {
    bytes: new Uint8Array([1, 2, 3]),
    id: 999n,
    name: "test",
  };
  const result = roundTrip(value) as typeof value;
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3]);
  assert.strictEqual(result.id, 999n);
  assert.strictEqual(result.name, "test");
});

test("encode produces a Uint8Array", () => {
  const encoded = encode({ ok: true, value: 42 });
  assert.ok(encoded instanceof Uint8Array);
  assert.ok(encoded.length > 0);
});
