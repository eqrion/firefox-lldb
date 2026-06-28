/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Source breakpoint by file:line against a source-map-only module. The line
// table comes from math.wasm.map (converted to DWARF). Own attach; continue
// mutates state.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.attach("sourcemap_factorial");
});
after(async () => {
  await s?.shutdown();
});

test("source breakpoint at math.cpp:24 resolves and fires at the exact line", async () => {
  await s.breakpointByLocation("math.cpp", 24);
  await s.continue();
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
  assert.equal(f0.line, 24);
});
