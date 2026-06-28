/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// StepOut from a callee returns to the caller. Ported from
// test/e2e-python/test_control_flow.py (test_step_in_out).

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

test(
  "StepOut from factorial returns to compute_factorial with shallower stack",
  async () => {
    await s.breakpointByName("compute_factorial");
    await s.breakpointByName("factorial");

    await s.continue(); // stops at compute_factorial
    await s.continue(); // stops at factorial (called from compute_factorial -> factorial(n))

    const framesIn = await s.frames();
    const depthIn = framesIn.length;
    assert.ok(depthIn >= 2, "depth at factorial should be >= 2");
    assert.match(framesIn[0].function, /factorial/);

    await s.stepOut();
    assert.notEqual((await s.state()).reason, "exited");
    const framesOut = await s.frames();
    assert.ok(framesOut.length < depthIn, "StepOut shallowed the stack");
    assert.match(framesOut[0].function, /compute_factorial/);
  }
);
