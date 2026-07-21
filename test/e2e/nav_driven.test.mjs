/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Driven navigation: our own session.navigate() (the path core/platform-session.ts
// uses to steer an already-attached tab to a new URL), as opposed to a
// page-triggered one. Proves the re-sync machinery — rdp-debuggee.ts's
// #scheduleResyncCheck forcing a stop when nothing pauses on its own, and
// the buffered breakpoint re-applying to the new page's target — leaves
// LLDB able to continue and hit that breakpoint again, rather than wedging
// waiting for a stop that never comes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session, continueUntilBreakpoint, sleep } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("navigation");
});
after(async () => {
  await s?.shutdown();
});

test("driven navigate() re-syncs and the breakpoint refires on the new page", async () => {
  await s.navigate(s.pageUrl("page2.html"));

  // page2 doesn't auto-run — calling it eagerly races the debugger's own
  // breakpoint re-application (#applyBreakpoints) against the page's script.
  // Settle first, matching self_redirect.test.mjs.
  await sleep(3000);
  // Call it twice in one evaluation, not once: the first hit lands on a
  // breakpoint site LLDB hasn't rebound to the new module yet (its cached
  // view is still the pre-navigation address), so gdbstub reports it as a
  // library change rather than a breakpoint — LLDB treats that as internal
  // housekeeping (re-resolve, then just continue) rather than a user-visible
  // stop, so it never surfaces here no matter how long we wait. That
  // housekeeping *does* rebind the site correctly, though (verified by
  // tracing real RSP traffic during this test's development), so the
  // second call, once the resumed thread reaches it, hits an address LLDB
  // now genuinely recognizes and reports as a real, visible breakpoint.
  s.evaluate("runFactorial(); runFactorial();");

  const st = await continueUntilBreakpoint(s);
  assert.equal(st.reason, "breakpoint");

  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
});
