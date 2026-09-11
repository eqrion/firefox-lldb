/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wire codec for the synchronous worker<->main RPC that bridges the component's
// (synchronous) `debuggee` interface to the async RDP client on the main thread.
//
// A message is: [u32 jsonLen][json bytes][u32 nBlobs][(u32 len, bytes)...].
// The JSON carries the structured value with binary buffers replaced by
// {$bin: index} refs, bigints as {$big: "..."}, and resource handles as
// {$res: type, id, ...extra}. This keeps large binaries (module bytecode,
// memory reads) out of JSON while staying simple.

const td = new TextDecoder();
const te = new TextEncoder();
const MAX_JSON_BYTES = 1024 * 1024;

/** @param {unknown} value @param {Uint8Array[]} blobs
 * @param {number} depth @param {{nodes: number}} budget @returns {unknown} */
function collect(value, blobs, depth, budget) {
  if (depth > 64 || ++budget.nodes > 100_000)
    throw new Error("RPC value exceeds nesting/node limit");
  if (typeof value === "string" && value.length > MAX_JSON_BYTES)
    throw new Error("RPC string exceeds metadata limit");
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))
    return { $number: Object.is(value, -0) ? "-0" : String(value) };

  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    blobs.push(value);
    return { $bin: blobs.length - 1 };
  }
  if (typeof value === "bigint") return { $big: value.toString() };
  if (Array.isArray(value)) return value.map((v) => collect(v, blobs, depth + 1, budget));
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    const fields = /** @type {Record<string, unknown>} */ (value);
    for (const k of Object.keys(fields)) {
      if (k === "__proto__") throw new Error("invalid RPC object key");
      out[k] = collect(fields[k], blobs, depth + 1, budget);
    }
    return out;
  }
  if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number")
    throw new Error("unsupported RPC value");
  return value;
}

/** @param {unknown} value @param {Uint8Array[]} blobs
 * @param {number} depth @param {{nodes: number}} budget @returns {unknown} */
function revive(value, blobs, depth, budget) {
  if (depth > 64 || ++budget.nodes > 100_000)
    throw new Error("RPC value exceeds nesting/node limit");
  if (value === null || typeof value !== "object") return value;
  if ("$bin" in value) {
    if (
      typeof value.$bin !== "number" ||
      !Number.isSafeInteger(value.$bin) ||
      value.$bin < 0 ||
      value.$bin >= blobs.length
    )
      throw new Error("invalid RPC binary reference");
    return blobs[value.$bin];
  }
  if ("$big" in value) {
    if (typeof value.$big !== "string" || value.$big.length > 128 || !/^-?\d+$/.test(value.$big))
      throw new Error("invalid RPC bigint");
    return BigInt(value.$big);
  }
  if ("$number" in value) {
    if (
      typeof value.$number !== "string" ||
      !["NaN", "Infinity", "-Infinity", "-0"].includes(value.$number)
    )
      throw new Error("invalid RPC number");
    return Number(value.$number);
  }
  if (Array.isArray(value)) return value.map((v) => revive(v, blobs, depth + 1, budget));
  /** @type {Record<string, unknown>} */
  const out = {};
  const fields = /** @type {Record<string, unknown>} */ (value);
  for (const k of Object.keys(fields)) {
    if (k === "__proto__") throw new Error("invalid RPC object key");
    out[k] = revive(fields[k], blobs, depth + 1, budget);
  }
  return out;
}

/** Encode within the SAB capacity before allocating the final message.
 * @param {unknown} value @returns {Uint8Array} */
export function encode(value) {
  /** @type {Uint8Array[]} */
  const blobs = [];
  const json = te.encode(JSON.stringify(collect(value, blobs, 0, { nodes: 0 })));
  if (json.length > MAX_JSON_BYTES) throw new Error("RPC metadata exceeds 1 MiB limit");
  let total = 4 + json.length + 4;
  for (const b of blobs) total += 4 + b.length;
  if (total > DATA_BYTES) throw new Error("RPC message exceeds 32 MiB limit");
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, json.length, true);
  o += 4;
  out.set(json, o);
  o += json.length;
  dv.setUint32(o, blobs.length, true);
  o += 4;
  for (const b of blobs) {
    dv.setUint32(o, b.length, true);
    o += 4;
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Validate the whole frame before exposing copied blobs or revived values.
 * @param {Uint8Array} bytes @returns {unknown} */
export function decode(bytes) {
  if (bytes.length < 8 || bytes.length > DATA_BYTES) throw new Error("invalid RPC frame length");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const jsonLen = dv.getUint32(o, true);
  o += 4;
  if (jsonLen > MAX_JSON_BYTES || o + jsonLen + 4 > bytes.length)
    throw new Error("invalid RPC metadata length");
  const json = JSON.parse(td.decode(bytes.subarray(o, o + jsonLen)));
  o += jsonLen;
  const nBlobs = dv.getUint32(o, true);
  o += 4;
  if (nBlobs > Math.floor((bytes.length - o) / 4)) throw new Error("invalid RPC blob count");
  /** @type {Uint8Array[]} */
  const blobs = [];
  for (let i = 0; i < nBlobs; i++) {
    if (o + 4 > bytes.length) throw new Error("truncated RPC blob length");
    const len = dv.getUint32(o, true);
    o += 4;
    if (o + len > bytes.length) throw new Error("truncated RPC blob");
    // Copy out of the SAB-backed view into a plain Uint8Array.
    blobs.push(bytes.slice(o, o + len));
    o += len;
  }
  if (o !== bytes.length) throw new Error("trailing RPC bytes");
  return revive(json, blobs, 0, { nodes: 0 });
}

// SharedArrayBuffer control layout (Int32Array indices) and sizing.
export const CTRL_STATE = 0; // 0 idle, 1 request pending, 2 response ready
export const CTRL_LEN = 1; // payload length in the data region
export const CTRL_WORDS = 4;
export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_RESPONSE = 2;
export const DATA_BYTES = 32 * 1024 * 1024; // 32 MiB payload region
