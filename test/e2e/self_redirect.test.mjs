/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An uncontrolled navigation (the page redirecting itself, not driven by our
// own session.navigate()) must not crash the debug session. Before the fix,
// #wasmActorByUrl kept pointing at the destroyed page's dead source actor,
// and the next breakpoint-position lookup against it (#snapOffset ->
// wasmBreakpointOffsets) threw uncaught, killing the whole gdbstub worker —
// see src/rdp/session.ts's #invalidateActorCaches()/target-destroyed-form
// handling.
//
// This only checks survival, not that the breakpoint refires correctly on
// the new page — that fuller contract (re-sync, no wedging, module
// unload/reload) is covered by the nav_*.test.mjs suite. The deeper gap once
// noted here — LLDB's own process/thread model not being told anything
// changed when the page's threads get swapped out without an intervening
// wasm-level stop — is now handled: session.ts reuses the old top-level tid
// across a swap (LLDB has no RSP mechanism to learn "tid N is gone" to do
// otherwise) and rdp-debuggee.ts surfaces a pause that already happened
// with nothing listening (hasUnwitnessedPause) instead of resuming past it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("self_redirect");
});
after(async () => {
  await s?.shutdown();
});

test("an uncontrolled self-redirect while paused does not crash the session", async () => {
  // Fire-and-forget: the debuggee is paused, and nothing here needs it to
  // resume on its own for the navigation to happen.
  s.evaluate("redirectToPage2()");

  // Give the navigation (destroy + recreate of the top-level target) time to
  // settle before touching the session again.
  await new Promise((r) => setTimeout(r, 3000));

  // Both of these exercise #wasmActorByUrl/#snapOffset against page 2 after
  // page 1's actors have died. Before the fix, the second one threw
  // uncaught inside the gdbstub component and killed the session outright
  // (surfacing as a disconnect, not a thrown JS error here).
  const st = await s.state();
  assert.equal(st.reason, "breakpoint", "session must still be alive and responsive");

  const bp = await s.breakpointByName("compute_factorial");
  assert.equal(
    bp.status,
    2,
    "setting a breakpoint against the new page must succeed, not hang or crash"
  );
});
