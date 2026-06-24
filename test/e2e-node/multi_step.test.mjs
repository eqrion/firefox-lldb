/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Five sequential step-instructions each advance the PC. Ported from
// test/e2e/test_control_flow.py (test_multiple_step_instructions).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip =
  process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
    ? false
    : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => {
  if (!skip) s = await Session.attach("factorial");
});
after(async () => {
  await s?.shutdown();
});

test("five sequential StepInstructions each advance the PC", { skip }, async () => {
  await s.breakpointByName("factorial");
  await s.continue();
  assert.notEqual((await s.state()).reason, "exited");
  assert.match((await s.topFrame()).function, /factorial/);

  let prevPc = (await s.topFrame()).pc;
  for (let i = 0; i < 5; i++) {
    await s.stepInstruction();
    assert.notEqual((await s.state()).reason, "exited", `process exited at step ${i + 1}`);
    const f0 = await s.topFrame();
    assert.notEqual(f0.pc, prevPc, `PC did not advance at step ${i + 1}`);
    prevPc = f0.pc;
  }
});
