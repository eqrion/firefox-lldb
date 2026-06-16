/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticModule } from "../../src/gdb/synthetic-module.js";

function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    const b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: pos };
}

function findCustomSection(bytes: Uint8Array, name: string): Uint8Array | null {
  let o = 8; // skip magic + version
  while (o < bytes.length) {
    const id = bytes[o++];
    const { value: size, next } = readUleb(bytes, o);
    o = next;
    const end = o + size;
    if (id === 0) {
      // custom section: name_length (uleb) + name + payload
      const { value: nameLen, next: nameStart } = readUleb(bytes, o);
      const nameBytes = bytes.slice(nameStart, nameStart + nameLen);
      const sectionName = new TextDecoder().decode(nameBytes);
      const payloadStart = nameStart + nameLen;
      if (sectionName === name) {
        return bytes.slice(payloadStart, end);
      }
    }
    o = end;
  }
  return null;
}

test("buildSyntheticModule emits a valid wasm header", () => {
  const { bytecode } = buildSyntheticModule({ name: "test.js", compDir: "/tmp", lineCount: 10 });
  assert.equal(bytecode[0], 0x00);
  assert.equal(bytecode[1], 0x61);
  assert.equal(bytecode[2], 0x73);
  assert.equal(bytecode[3], 0x6d);
  assert.equal(bytecode[4], 0x01); // version
  assert.equal(bytecode[5], 0x00);
  assert.equal(bytecode[6], 0x00);
  assert.equal(bytecode[7], 0x00);
});

test("buildSyntheticModule has .debug_abbrev, .debug_info, .debug_line sections", () => {
  const { bytecode } = buildSyntheticModule({ name: "test.js", compDir: "/tmp", lineCount: 5 });
  assert.ok(findCustomSection(bytecode, ".debug_abbrev"), "missing .debug_abbrev");
  assert.ok(findCustomSection(bytecode, ".debug_info"), "missing .debug_info");
  assert.ok(findCustomSection(bytecode, ".debug_line"), "missing .debug_line");
});

test("codeOffset is past the header, type, function, and code section id+size", () => {
  const { codeOffset } = buildSyntheticModule({ name: "test.js", compDir: "/tmp", lineCount: 10 });
  // header(8) + type_section(6) + func_section(4) + code_id(1) + code_size_uleb(1) = 20
  assert.equal(codeOffset, 20);
});

test("codeOffset < bytecode.length and all source lines are in range", () => {
  const lineCount = 50;
  const { bytecode, codeOffset } = buildSyntheticModule({ name: "a.js", compDir: "/tmp", lineCount });
  assert.ok(codeOffset < bytecode.length);
  // Every valid source line (1..lineCount) as a WasmAddr offset must be < bytecode.length
  for (let line = 1; line <= lineCount; line++) {
    assert.ok(
      codeOffset + line < bytecode.length,
      `pc for line ${line} = ${codeOffset + line} >= bytecode.length ${bytecode.length}`,
    );
  }
});

test(".debug_info contains the file name and comp_dir as C strings", () => {
  const name = "math.js";
  const compDir = "/tmp/firefox-lldb-abc";
  const { bytecode } = buildSyntheticModule({ name, compDir, lineCount: 3 });
  const info = findCustomSection(bytecode, ".debug_info");
  assert.ok(info);
  const text = new TextDecoder().decode(info);
  assert.ok(text.includes(name), `.debug_info missing name "${name}"`);
  assert.ok(text.includes(compDir), `.debug_info missing compDir "${compDir}"`);
});

test(".debug_line header version is 4", () => {
  const { bytecode } = buildSyntheticModule({ name: "x.js", compDir: "/tmp", lineCount: 2 });
  const line = findCustomSection(bytecode, ".debug_line");
  assert.ok(line);
  // unit_length is first 4 bytes, then 2-byte version
  const version = line[4] | (line[5] << 8);
  assert.equal(version, 4);
});

test("lineCount=0 is handled gracefully (treated as 1)", () => {
  const { bytecode, codeOffset } = buildSyntheticModule({ name: "e.js", compDir: "/tmp", lineCount: 0 });
  assert.ok(bytecode.length > 0);
  assert.ok(codeOffset < bytecode.length);
});
