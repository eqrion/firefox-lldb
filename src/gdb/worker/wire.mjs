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

function collect(value, blobs) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    blobs.push(value);
    return { $bin: blobs.length - 1 };
  }
  if (typeof value === "bigint") return { $big: value.toString() };
  if (Array.isArray(value)) return value.map((v) => collect(v, blobs));
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = collect(value[k], blobs);
    return out;
  }
  return value;
}

function revive(value, blobs) {
  if (value === null || typeof value !== "object") return value;
  if ("$bin" in value) return blobs[value.$bin];
  if ("$big" in value) return BigInt(value.$big);
  if (Array.isArray(value)) return value.map((v) => revive(v, blobs));
  const out = {};
  for (const k of Object.keys(value)) out[k] = revive(value[k], blobs);
  return out;
}

/** Encode a value into a single Uint8Array message. */
export function encode(value) {
  const blobs = [];
  const json = te.encode(JSON.stringify(collect(value, blobs)));
  let total = 4 + json.length + 4;
  for (const b of blobs) total += 4 + b.length;
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

/** Decode a message (a Uint8Array view) back into a value. */
export function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const jsonLen = dv.getUint32(o, true);
  o += 4;
  const json = JSON.parse(td.decode(bytes.subarray(o, o + jsonLen)));
  o += jsonLen;
  const nBlobs = dv.getUint32(o, true);
  o += 4;
  const blobs = [];
  for (let i = 0; i < nBlobs; i++) {
    const len = dv.getUint32(o, true);
    o += 4;
    // Copy out of the SAB-backed view into a plain Uint8Array.
    blobs.push(bytes.slice(o, o + len));
    o += len;
  }
  return revive(json, blobs);
}

// SharedArrayBuffer control layout (Int32Array indices) and sizing.
export const CTRL_STATE = 0; // 0 idle, 1 request pending, 2 response ready
export const CTRL_LEN = 1; // payload length in the data region
export const CTRL_WORDS = 4;
export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_RESPONSE = 2;
export const DATA_BYTES = 32 * 1024 * 1024; // 32 MiB payload region
