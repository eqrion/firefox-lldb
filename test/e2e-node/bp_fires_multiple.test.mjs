/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A breakpoint in a recursive function fires on each recursion level. Ported
// from test/e2e/test_control_flow.py (test_breakpoint_fires_multiple_times).

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
  "breakpoint on factorial fires with n = 10, 9, 8 on successive continues",
  async () => {
    await s.breakpointByName("factorial");

    const nValues = [];
    for (let i = 0; i < 3; i++) {
      await s.continue();
      const st = await s.state();
      assert.equal(st.reason, "breakpoint", `stop ${i + 1} should be a breakpoint`);
      assert.match((await s.topFrame()).function, /factorial/);
      const n = await s.variable(0, "n");
      assert.equal(n.valid, true);
      nValues.push(n.signed);
    }

    assert.deepEqual(nValues, [10, 9, 8]);
  }
);
