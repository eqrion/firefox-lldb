/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// LLDB's wasm object reader currently maps function names from the `name`
// custom section as if its function indices excluded imports. The wasm format
// includes imports in that index space, so names after the imported functions
// are attached to the wrong code addresses. Embedded DWARF already carries the
// authoritative function names and ranges; removing only the `name` section
// prevents duplicate, incorrectly-addressed symbol matches without touching
// executable code or debug sections.

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const NAME_BYTES = new Uint8Array([0x6e, 0x61, 0x6d, 0x65]);

function readU32(bytes: Uint8Array, start: number, end = bytes.length) {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < end && offset < start + 5; offset++) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + 1 };
    shift += 7;
  }
  return null;
}

function isNameSection(bytes: Uint8Array, payloadStart: number, payloadEnd: number): boolean {
  const nameLength = readU32(bytes, payloadStart, payloadEnd);
  if (!nameLength || nameLength.value !== NAME_BYTES.length) return false;
  if (nameLength.next + NAME_BYTES.length > payloadEnd) return false;
  return NAME_BYTES.every((byte, i) => bytes[nameLength.next + i] === byte);
}

export function stripWasmNameSection(bytes: Uint8Array): Uint8Array {
  if (bytes.length < WASM_HEADER.length || !WASM_HEADER.every((byte, i) => bytes[i] === byte)) {
    return bytes;
  }

  const kept: Uint8Array[] = [bytes.subarray(0, WASM_HEADER.length)];
  let offset = WASM_HEADER.length;
  let stripped = false;

  while (offset < bytes.length) {
    const sectionStart = offset;
    const sectionId = bytes[offset++];
    const size = readU32(bytes, offset);
    if (!size) return bytes;
    const payloadStart = size.next;
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > bytes.length) return bytes;

    if (sectionId === 0 && isNameSection(bytes, payloadStart, payloadEnd)) {
      stripped = true;
    } else {
      kept.push(bytes.subarray(sectionStart, payloadEnd));
    }
    offset = payloadEnd;
  }

  if (!stripped) return bytes;
  const length = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let write = 0;
  for (const part of kept) {
    out.set(part, write);
    write += part.length;
  }
  return out;
}
