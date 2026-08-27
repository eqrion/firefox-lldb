/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Separate DWARF (emscripten -gseparate-dwarf): the served wasm carries no
// debug sections, only an external_debug_info section naming math.debug.wasm.
// The debug file is fetched from the page's server and merged into the bytecode
// handed to LLDB, so debugging is indistinguishable from an embedded-DWARF build.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("separate_dwarf");
});
after(async () => {
  await s?.shutdown();
});

test("function breakpoint resolves to source from the separate debug file", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});

test("source-level arguments read from the external DWARF", async () => {
  const n = await s.variable(0, "n");
  assert.equal(n.valid, true, "the C++ parameter name resolves");
  assert.equal(n.signed, 10, "n holds the value the page passed");
});

test("source breakpoint by file:line resolves against the external DWARF", async () => {
  await s.breakpointByLocation("math.cpp", 5);
  await s.continue();
  const f0 = await s.topFrame();
  assert.match(f0.function, /factorial/);
  assert.equal(f0.line, 5);
});
