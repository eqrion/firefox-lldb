/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Variable evaluation against a source-map-only module.
//
// Source maps carry no variable, type, or location information. The synthesized
// DWARF therefore exposes the raw wasm locals, typed by their wasm value type
// (i32 -> int32_t, etc.) and named positionally (arg0, arg1, ...). This makes
// the locals enumerable and readable as primitives, which is the extent of
// variable evaluation possible from a source map.
//
// Note this does NOT recover source-level variables: their names are absent,
// and for emscripten -O0 output the parameters are spilled to the shadow stack
// in linear memory (DW_OP_fbreg), so the wasm locals do not hold the C++
// argument values past the prologue. Reading source variables by name/value is
// only possible with real DWARF.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("sourcemap_sum");
});
after(async () => {
  await s?.shutdown();
});

test("stopped in sum_range at math.cpp (call stack + synthesized DWARF)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /sum_range/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
});

test("wasm locals are exposed as readable, typed primitives", async () => {
  // sum_range has two i32 params, surfaced positionally as arg0/arg1.
  const arg0 = await s.variable(0, "arg0");
  const arg1 = await s.variable(0, "arg1");
  assert.equal(arg0.valid, true, "arg0 resolves to a wasm local");
  assert.equal(arg1.valid, true, "arg1 resolves to a wasm local");
  assert.equal(Number.isInteger(arg0.signed), true, "arg0 reads as an i32");
  assert.equal(Number.isInteger(arg1.signed), true, "arg1 reads as an i32");
});

test("source-level variable names are not recovered from a source map", async () => {
  // The C++ parameter name "lo" is absent from the source map, so it does not
  // resolve as a variable.
  const lo = await s.variable(0, "lo");
  assert.equal(lo.valid, false);
});
