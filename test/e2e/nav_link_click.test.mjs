/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Navigation via a user gesture: clicking a plain <a href> link, rather than
// script assigning location.

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

test("clicking a link navigates and the breakpoint refires on the new page", async () => {
  s.evaluate("document.getElementById('go').click()");

  // Give the new page a moment to discover its wasm module before driving
  // it (mirrors self_redirect.test.mjs's settle wait).
  await sleep(3000);
  // Call it twice, not once: the first hit lands on a breakpoint site LLDB
  // hasn't rebound to the new module yet (its cached view is still the
  // pre-navigation address), so gdbstub reports it as a library change
  // rather than a breakpoint — LLDB treats that as internal housekeeping
  // (re-resolve, then just continue) rather than a user-visible stop. That
  // housekeeping does rebind the site correctly (see rdp-debuggee.ts's
  // Module.name), so the second call, once the resumed thread reaches it,
  // hits an address LLDB now genuinely recognizes and reports for real.
  s.evaluate("runFactorial(); runFactorial();");

  const st = await continueUntilBreakpoint(s);
  assert.equal(st.reason, "breakpoint");

  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
});
