/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// OOP fixture call-stack tests. Ported from test/e2e/test_call_stack.py (oop
// entry) and test/e2e/test_control_flow.py (test_dynamic_dispatch,
// test_inspect_virtual_this). All tests share one stopped session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip =
  process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
    ? false
    : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => {
  if (!skip) s = await Session.stoppedAtBreakpoint("oop");
});
after(async () => {
  await s?.shutdown();
});

test("stopped in area at oop.cpp (call stack + DWARF)", { skip }, async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /area/);
  assert.equal(f0.file?.endsWith("oop.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});

test("virtual call resolved: frame1 is shape_area (dynamic dispatch)", { skip }, async () => {
  const frames = await s.frames();
  assert.ok(frames.length >= 2, `expected >= 2 frames, got ${frames.length}`);
  assert.match(frames[0].function, /area/);
  assert.match(frames[1].function, /shape_area/);
});

test("stopped frame file is oop.cpp", { skip }, async () => {
  const f0 = await s.topFrame();
  assert.equal(f0.file?.endsWith("oop.cpp"), true);
});
