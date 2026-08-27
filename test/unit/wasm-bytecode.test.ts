/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  stripWasmNameSection,
  wasmExternalDebugInfo,
  wasmFunctionRange,
} from "../../src/gdb/wasm-bytecode.js";

const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

test("stripWasmNameSection removes only the name custom section", () => {
  const type = [0x01, 0x01, 0x00];
  const name = [0x00, 0x06, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0xaa];
  const debug = [0x00, 0x08, 0x06, 0x2e, 0x64, 0x65, 0x62, 0x75, 0x67, 0xbb];
  const input = new Uint8Array([...header, ...type, ...name, ...debug]);

  assert.deepEqual(stripWasmNameSection(input), new Uint8Array([...header, ...type, ...debug]));
});

test("stripWasmNameSection leaves malformed or name-free modules unchanged", () => {
  const nameFree = new Uint8Array([...header, 0x01, 0x01, 0x00]);
  const malformed = new Uint8Array([...header, 0x00, 0x7f]);
  assert.strictEqual(stripWasmNameSection(nameFree), nameFree);
  assert.strictEqual(stripWasmNameSection(malformed), malformed);
});

test("wasmFunctionRange finds encoded bodies including their size fields", () => {
  const code = [0x0a, 0x08, 0x02, 0x02, 0x00, 0x0b, 0x03, 0x00, 0x01, 0x0b];
  const module = new Uint8Array([...header, ...code]);

  assert.deepEqual(wasmFunctionRange(module, 12), { start: 11, end: 14 });
  assert.deepEqual(wasmFunctionRange(module, 16), { start: 14, end: 18 });
  assert.equal(wasmFunctionRange(module, 10), undefined);
  assert.equal(wasmFunctionRange(new Uint8Array([...header, 0x0a, 0x7f]), 12), undefined);
});

function customSection(name: string, payload: number[] = []): number[] {
  const nameBytes = [...Buffer.from(name)];
  const content = [nameBytes.length, ...nameBytes, ...payload];
  return [0x00, content.length, ...content];
}

test("wasmExternalDebugInfo reads the separate DWARF path", () => {
  const path = "math.debug.wasm";
  const section = customSection("external_debug_info", [path.length, ...Buffer.from(path)]);
  const module = new Uint8Array([...header, 0x01, 0x01, 0x00, ...section]);

  assert.equal(wasmExternalDebugInfo(module), path);
  assert.equal(
    wasmExternalDebugInfo(new Uint8Array([...header, ...customSection("name")])),
    undefined
  );
  assert.equal(wasmExternalDebugInfo(new Uint8Array([...header, 0x00, 0x7f])), undefined);
});
