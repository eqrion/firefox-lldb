/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wasm trap surface behaviour. Ported from test/e2e/test_wasm_trap.py.
//
// Currently marked todo (expected failure): Firefox does not pause on wasm
// traps with pauseOnExceptions=false, so the process exits rather than
// stopping with an exception stop reason.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.attach("trap");
});
after(async () => {
  await s?.shutdown();
});

test(
  "wasm integer divide-by-zero surfaces as exception stop reason",
  {
    todo: "Firefox does not pause on wasm traps with pauseOnExceptions=false (process exits instead)",
  },
  async () => {
    await s.breakpointByName("cause_trap");
    await s.continue();
    assert.equal((await s.state()).reason, "breakpoint");

    await s.stepOver();
    const st = await s.state();
    assert.equal(st.reason, "exception", `expected exception, got ${st.reason}`);
  }
);
