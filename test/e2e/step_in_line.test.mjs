/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Source-line step-in (`thread step-in`, the `s` alias) must advance to a new
// source line in a single step, not stop after the first wasm instruction of
// a multi-instruction line. Regression test for ThreadPlanWasmStep ignoring
// the AddressRange/LineEntry it was given and stopping on any PC change.

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

test("step-in advances exactly one source line at a time through factorial's multi-instruction lines", async () => {
  await s.breakpointByName("compute_factorial");
  await s.continue(); // stops at compute_factorial, math.cpp:24

  const start = await s.topFrame();
  assert.equal(start.line, 24);
  assert.match(start.function, /^::compute_factorial/);

  // Step into factorial's prologue (its opening brace line).
  await s.stepIn();
  const prologue = await s.topFrame();
  assert.equal(prologue.function, "factorial(int)");
  assert.equal(prologue.line, 4);

  // n=10 at the outermost call, so `if (n <= 1) return 1;` (line 5) does not
  // return here: the condition, compare, and branch are all still line 5, but
  // executing them takes several wasm instructions. A single step-in must
  // cross all of them and land on line 6 -- not stop partway through line 5,
  // which is what turned "step" into "step instruction" in disguise.
  await s.stepIn();
  const line5 = await s.topFrame();
  assert.equal(line5.function, "factorial(int)");
  assert.equal(line5.line, 5, "one step-in reaches the if-line");

  await s.stepIn();
  const line6 = await s.topFrame();
  assert.equal(line6.function, "factorial(int)");
  assert.equal(line6.line, 6, "the next step-in crosses the whole if-line in one step, landing on line 6");
});
