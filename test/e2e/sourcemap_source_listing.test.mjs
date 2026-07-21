/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Source listing for a module that ships a source map instead of DWARF. The
// DWARF is synthesized from math.wasm.map at debug time; these read-only tests
// confirm wasm and JS frames carry valid file/line info from it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("sourcemap_factorial");
});
after(async () => {
  await s?.shutdown();
});

test("wasm frame has a valid file and positive line number (from source map)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});

test("source-map materialization remains rooted in the per-session source directory", async () => {
  const frame = (await s.frames()).find((f) => f.file?.includes("math.cpp"));
  assert.ok(frame?.file, "expected a source-mapped math.cpp frame");
  assert.match(frame.file, /firefox-lldb-.*math\.wasm\.[a-f0-9]+\.src/);
});

test("a JS caller frame has a valid file ending in .js with a positive line number", async () => {
  const frames = await s.frames();
  const jsFrame = frames.find((f) => f.file?.endsWith(".js"));
  assert.ok(jsFrame, "no JS caller frame found in call stack");
  assert.ok(jsFrame.line > 0, `JS frame line number is positive (got ${jsFrame.line})`);
});
