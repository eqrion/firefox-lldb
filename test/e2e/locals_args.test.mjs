/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Multiple-argument locals on a second fixture/function (sum_range), ported from
// test/e2e-python/test_locals.py. Own file => own attach/process (see README).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("sum_range");
});
after(async () => {
  await s?.shutdown();
});

test("stopped in sum_range at math.cpp (call stack + DWARF)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /sum_range/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
});

test("sum_range args lo == 1 and hi == 100", async () => {
  const lo = await s.variable(0, "lo");
  const hi = await s.variable(0, "hi");
  assert.equal(lo.valid, true);
  assert.equal(hi.valid, true);
  assert.equal(lo.signed, 1);
  assert.equal(hi.signed, 100);
});
