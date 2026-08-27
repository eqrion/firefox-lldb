/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Attaching to a page that is already paused when the debugger arrives.
//
// firefox-lldb sets pauseOnExceptions on the tab before navigating, so an
// uncaught exception during page load pauses the page's thread before
// RdpDebuggee.primeStop runs. primeStop used to interrupt that thread and wait
// for the resulting pause, but Firefox answers an interrupt aimed at an
// already-paused thread with an error reply instead of a paused event, so the
// wait never completed and the whole attach hung.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("throw_on_load");
});
after(async () => {
  await s?.shutdown();
});

test("attach completes and a breakpoint still fires on an already-paused page", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});
