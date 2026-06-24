/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Two breakpoints hit in execution order. Ported from
// test/e2e/test_control_flow.py (test_two_breakpoints_continue).

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

test(
  "two breakpoints fire in execution order: compute_factorial then factorial",
  { skip },
  async () => {
    await s.breakpointByName("compute_factorial");
    await s.breakpointByName("factorial");

    await s.continue();
    const f0first = await s.topFrame();
    assert.match(f0first.function, /compute_factorial/);

    await s.continue();
    const f0second = await s.topFrame();
    assert.match(f0second.function, /factorial/);
    assert.doesNotMatch(f0second.function, /compute_/);
  }
);
