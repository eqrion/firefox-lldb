/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// factorial(10) recurses; the call stack contains multiple factorial frames.
// Ported from test/e2e-python/test_recursion.py (test_factorial_recursion_depth).

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

test("factorial recursion: stack has >= 2 factorial frames", async () => {
  await s.breakpointByName("compute_factorial");
  await s.breakpointByName("factorial");

  await s.continue(); // compute_factorial
  await s.continue(); // factorial(10)

  const frames = await s.frames();
  const factorialFrames = frames.filter((f) => /factorial/.test(f.function));
  assert.ok(
    factorialFrames.length >= 2,
    `expected >= 2 factorial frames; got ${factorialFrames.length}: ${JSON.stringify(frames.map((f) => f.function))}`
  );
});
