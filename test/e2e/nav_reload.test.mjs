/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Same-URL reload: location.reload() navigates to the exact same URL. Proves
// the debugger doesn't keep serving a stale cached bytecode for the reloaded
// module (rdp-debuggee.ts's #onNavigated clears #bytecodeByUrl/#moduleByUrl
// on any navigation, same-URL or not) and that the breakpoint still refires
// once the page runs again.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session, continueUntilBreakpoint } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("navigation");
});
after(async () => {
  await s?.shutdown();
});

test("location.reload() re-fetches module bytes and the breakpoint refires", async () => {
  const fetchesBefore = s.wasmFetchCount();
  assert.ok(
    fetchesBefore >= 1,
    "the debugger must have already fetched module bytes at least once by the first breakpoint"
  );

  s.evaluate("reloadSelf()");
  // Give the reload (destroy + recreate of the top-level target, then a
  // fresh page load) time to settle before driving the reloaded page —
  // mirrors self_redirect.test.mjs's settle wait.
  await new Promise((r) => setTimeout(r, 3000));

  // index.html doesn't auto-run on load (it would race the initial attach's
  // own --fire), so drive it again now that the page has reloaded. Call it
  // twice, not once: the first hit lands on a breakpoint site LLDB hasn't
  // rebound to the reloaded module yet (its cached view is still the
  // pre-reload address — this holds even for a same-URL reload, see
  // rdp-debuggee.ts's Module.name), so gdbstub reports it as a library
  // change rather than a breakpoint, and LLDB treats that as internal
  // housekeeping rather than a user-visible stop. The second call, once the
  // resumed thread reaches it, hits an address LLDB now genuinely
  // recognizes and reports for real.
  s.evaluate("runFactorial(); runFactorial();");
  const st = await continueUntilBreakpoint(s);
  assert.equal(st.reason, "breakpoint");

  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);

  assert.ok(
    s.wasmFetchCount() > fetchesBefore,
    "reload must re-fetch module bytes, not serve the stale cached bytecode"
  );
});
