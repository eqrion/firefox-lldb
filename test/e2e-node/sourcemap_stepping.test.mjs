/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stepping against a source-map-only module: the step machinery relies on the
// DWARF synthesized from math.wasm.map. Own attach; the step mutates state, so
// this is the only test against the session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("sourcemap_factorial");
});
after(async () => {
  await s?.shutdown();
});

test("step-instruction advances the PC within compute_factorial", async () => {
  const pcBefore = (await s.topFrame()).pc;
  assert.notEqual(pcBefore, "0x0");
  await s.stepInstruction();
  assert.equal((await s.state()).reason !== "none", true);
  const f0 = await s.topFrame();
  assert.notEqual(f0.pc, pcBefore);
  assert.match(f0.function, /compute_factorial/);
});
