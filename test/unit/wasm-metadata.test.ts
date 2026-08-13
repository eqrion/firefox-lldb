/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyntheticModule } from "../../src/wasm/synthetic-debug-module.js";
import { wasmCustomSectionNames, wasmDebugInfoHints } from "../../src/wasm/metadata.js";

test("Wasm metadata normalizes DWARF and source map custom sections", () => {
  const { bytecode } = buildSyntheticModule({
    name: "fixture.js",
    compDir: "/fixture",
    lineCount: 3,
  });
  const bytes = concatenate(bytecode, customSection("sourceMappingURL"));

  assert.deepEqual(
    wasmCustomSectionNames(bytes).filter(
      (name) => name.startsWith(".debug_") || name === "sourceMappingURL"
    ),
    [".debug_abbrev", ".debug_info", ".debug_line", "sourceMappingURL"]
  );
  assert.deepEqual(wasmDebugInfoHints(bytes), ["dwarf", "source-map"]);
});

test("Wasm metadata rejects truncated section encodings", () => {
  const header = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
  assert.throws(
    () => wasmCustomSectionNames(concatenate(header, Uint8Array.of(0, 0x80))),
    /invalid WebAssembly u32 encoding/
  );
  assert.throws(
    () => wasmCustomSectionNames(concatenate(header, Uint8Array.of(0, 2, 3, 0x61))),
    /name extends past end/
  );
});

function customSection(name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payload = Uint8Array.of(...uleb(nameBytes.length), ...nameBytes);
  return Uint8Array.of(0, ...uleb(payload.length), ...payload);
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
