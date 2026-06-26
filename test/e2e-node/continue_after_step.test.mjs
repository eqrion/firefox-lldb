/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// After instruction steps, Continue correctly hits the next breakpoint. Ported
// from test/e2e/test_control_flow.py (test_continue_after_step).

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

test("step 3x then continue hits the factorial breakpoint", async () => {
  await s.breakpointByName("compute_factorial");
  await s.breakpointByName("factorial");

  await s.continue(); // stops at compute_factorial
  assert.match((await s.topFrame()).function, /compute_factorial/);

  for (let i = 0; i < 3; i++) {
    await s.stepInstruction();
    assert.notEqual((await s.state()).reason, "exited", `exited at step ${i + 1}`);
  }

  await s.continue(); // should hit factorial
  const f0 = await s.topFrame();
  assert.match(f0.function, /factorial/);
  assert.doesNotMatch(f0.function, /compute_/);
});
