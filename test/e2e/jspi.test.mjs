/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// JSPI (JS Promise Integration) tests. The fixture calls an async JS import
// (setTimeout-based) so the wasm stack suspends and resumes mid-function.
//
// The first test breaks at before_suspend (before any JSPI magic). The final
// test continues past the suspend point to after_suspend and verifies the
// stack is intact after resume.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("jspi");
});
after(async () => {
  await s?.shutdown();
});

test("breakpoint fires at before_suspend (pre-suspend entry point)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /before_suspend/);
  assert.equal(f0.file?.endsWith("jspi.c"), true);
});

test("value parameter is readable at before_suspend", async () => {
  const value = await s.variable(0, "value");
  assert.equal(value.valid, true);
  assert.equal(value.signed, 99);
});

test("continuing past the suspend point stops at after_suspend", async () => {
  await s.breakpointByName("after_suspend");
  await s.continue();
  const st = await s.state();
  assert.equal(st.reason, "breakpoint");
  const f0 = await s.topFrame();
  assert.match(f0.function, /after_suspend/);
});
