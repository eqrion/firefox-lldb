/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// End-to-end attach test for the embedded wasm LLDB. Proves the wasm process
// plugin and its GDB-remote extensions work: attach, breakpoints, DWARF symbols
// + line table, the call stack (qWasmCallStack, with JS frames interleaved), and
// locals (qWasmLocal). Ported from test/e2e/test_call_stack.py + test_locals.py.
//
// Requires headless Firefox + built fixtures (`npm run build:fixtures`). Each
// attach must run in its own process (see README), so this file does a single
// attach in before() and all tests assert against that one stopped state.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip = process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
  ? false
  : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => { if (!skip) s = await Session.stoppedAtBreakpoint("factorial"); });
after(async () => { await s?.shutdown(); });

test("stopped in compute_factorial at math.cpp:24", { skip }, async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
  assert.equal(f0.line, 24);
});

test("call stack interleaves the wasm frame with JS frames (qWasmCallStack)", { skip }, async () => {
  const frames = await s.frames();
  assert.ok(frames.length >= 2, `expected >= 2 frames, got ${frames.length}`);
  assert.match(frames[0].function, /compute_factorial/);
  assert.ok(frames.some((f) => /\.js$/.test(f.file ?? "")), "a JS caller frame is present");
});

test("local argument n == 10 (qWasmLocal + DWARF)", { skip }, async () => {
  const n = await s.variable(0, "n");
  assert.equal(n.valid, true);
  assert.equal(n.unsigned, 10);
});
