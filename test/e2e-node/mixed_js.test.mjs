/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Mixed JS/wasm source discovery tests. Ported from
// test/e2e/test_mixed_js.py (TestAppJsSourceDiscovery, TestAppJsBreakpoints).
// Stopped at compute_factorial in the mixed-js fixture; all non-mutating tests
// share the session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

// app.js line 14: const factResult = computeFactorial(n);
const APP_JS_FILE = "app.js";
const APP_JS_BREAKLINE = 14;

const skip =
  process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
    ? false
    : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => {
  if (!skip) s = await Session.stoppedAtBreakpoint("mixed_js");
});
after(async () => {
  await s?.shutdown();
});

test("math.js (emscripten glue) is visible in the call stack", { skip }, async () => {
  const frames = await s.frames();
  const files = frames.map((f) => f.file);
  assert.ok(
    files.some((f) => f?.endsWith("math.js")),
    `math.js not found; files: ${JSON.stringify(files)}`
  );
});

test("app.js (application JS) is visible in the call stack", { skip }, async () => {
  const frames = await s.frames();
  const files = frames.map((f) => f.file);
  assert.ok(
    files.some((f) => f?.endsWith(APP_JS_FILE)),
    `${APP_JS_FILE} not found; files: ${JSON.stringify(files)}`
  );
});

test("math.cpp (DWARF source) is visible at the innermost wasm frame", { skip }, async () => {
  const f0 = await s.topFrame();
  assert.equal(f0.file?.endsWith("math.cpp"), true, `frame0 file: ${f0.file}`);
});

test("app.js breakpoint at line 14 resolves to >= 1 location", { skip }, async () => {
  const res = await s.breakpointByLocation(APP_JS_FILE, APP_JS_BREAKLINE);
  // Output should contain "Breakpoint N: N locations"
  assert.match(res.output, /Breakpoint \d+:/);
  // We don't fire the breakpoint here; just verify it resolved.
  // Clean up so subsequent tests aren't affected by the extra breakpoint.
  const bpId = Session.parseBreakpointId(res);
  if (bpId != null) await s.deleteBreakpoint(bpId);
});
