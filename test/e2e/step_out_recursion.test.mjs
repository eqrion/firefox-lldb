/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// StepOut from a recursive frame returns to the immediate caller. Ported from
// test/e2e-python/test_control_flow.py (test_step_out_in_recursion).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.attach("factorial");
});
after(async () => {
  await s?.shutdown();
});

test("StepOut from factorial(9) returns to factorial(10) frame depth", async () => {
  await s.breakpointByName("factorial");

  await s.continue();
  const n10 = await s.variable(0, "n");
  assert.equal(n10.valid, true);
  assert.equal(n10.signed, 10);
  const depth10 = (await s.frames()).length;

  await s.continue();
  const n9 = await s.variable(0, "n");
  assert.equal(n9.valid, true);
  assert.equal(n9.signed, 9);
  const depth9 = (await s.frames()).length;
  assert.ok(depth9 > depth10, "recursive call increased stack depth");

  await s.stepOut();
  assert.notEqual((await s.state()).reason, "exited");
  const depthAfter = (await s.frames()).length;
  assert.equal(depthAfter, depth10, "StepOut restores depth to factorial(10) level");
  assert.match((await s.topFrame()).function, /factorial/);
});
