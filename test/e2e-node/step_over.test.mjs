/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// StepOver advances the PC without increasing call-stack depth. Ported from
// test/e2e/test_control_flow.py (test_step_over).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip = process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
  ? false
  : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => { if (!skip) s = await Session.attach("factorial"); });
after(async () => { await s?.shutdown(); });

test("StepOver advances PC without increasing call-stack depth", { skip }, async () => {
  await s.breakpointByName("compute_factorial");
  await s.breakpointByName("factorial");

  await s.continue(); // compute_factorial
  await s.continue(); // factorial

  const framesBefore = await s.frames();
  const depthBefore = framesBefore.length;
  const pcBefore = framesBefore[0].pc;
  assert.match(framesBefore[0].function, /factorial/);

  await s.stepOver();
  assert.notEqual((await s.state()).reason, "exited");

  const framesAfter = await s.frames();
  assert.notEqual(framesAfter[0].pc, pcBefore, "PC advanced");
  assert.ok(framesAfter.length <= depthBefore, "depth did not increase");
});
