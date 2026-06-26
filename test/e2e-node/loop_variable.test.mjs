/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Loop variable 'i' becomes visible once execution enters the loop body.
// Ported from test/e2e/test_locals.py (test_loop_variable).

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

test("loop variable 'i' is visible once execution enters the loop body", async () => {
  let iVar = await s.variable(0, "i");
  for (let step = 0; step < 20 && !iVar.valid; step++) {
    await s.stepInstruction();
    const st = await s.state();
    if (st.reason === "exited") break;
    iVar = await s.variable(0, "i");
  }
  assert.equal(iVar.valid, true, "loop variable 'i' not visible after 20 steps");
});
