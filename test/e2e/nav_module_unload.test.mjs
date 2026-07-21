/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Navigating to a page whose wasm module has a different URL must unload the
// old module from the gdbstub component's view, not just add the new one.
// Before this fix, the component's AddrSpace was add-only
// (vendor/gdbstub-component's addr.rs) — a navigated-away page's modules
// lingered in the library list forever, at their original addresses, serving
// stale DWARF. page3.html serves a byte-identical copy of math.wasm under a
// different URL (math2.wasm) specifically to exercise this.
//
// This only checks that the new module loads and stays debuggable — not that
// "image list" stops showing math.wasm. It doesn't: traced live over RSP
// during this test's development, the component's qXfer:libraries response
// correctly drops math.wasm from the very first post-navigation read (and
// never reports it again), but LLDB's own module list
// (ProcessGDBRemote::LoadModules -> Target::GetImages) does not act on that
// shrinkage — the old entry lingers in "image list" regardless of what the
// wire says. That's an LLDB client-side limitation, not something fixable
// from this repo (see the module-name-suffix and library-stop-reason
// limitations noted in rdp-debuggee.ts and lib.rs for the same class of
// issue).
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

test("navigating to a page with a different module URL loads the new module and stays debuggable", async () => {
  await s.navigate(s.pageUrl("page3.html"));

  // Start continuing right away, not after a settle wait: the buffered
  // breakpoint is bound to math.wasm's URL, which doesn't exist on this
  // page at all (it serves math2.wasm instead), so nothing can pause on
  // its own — this relies entirely on rdp-debuggee.ts's
  // #scheduleResyncCheck forcing a stop within its short grace window,
  // which only fires while a continue is genuinely outstanding, i.e.
  // called before that window elapses.
  //
  // That forced stop reports as a library change, which LLDB processes by
  // re-resolving its existing compute_factorial breakpoint against the new
  // module (confirmed by tracing real RSP traffic during this test's
  // development — a fresh Z0 lands on the new module's address) — but
  // that's housekeeping, not a stop LLDB reports to the user, so it goes
  // on to send a real, plain continue and waits for a genuine subsequent
  // stop. Trigger the run until that housekeeping has finished. Under the
  // suite's normal four-way concurrency, rebinding can take longer than a
  // fixed delay; a one-shot call made before the new site exists is lost.
  const continued = continueUntilBreakpoint(s);
  const trigger = setInterval(() => s.evaluate("runFactorial()"), 500);
  let st;
  try {
    st = await continued;
  } finally {
    clearInterval(trigger);
  }

  assert.equal(st.reason, "breakpoint");
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);

  const postNav = await s.command("image list");
  assert.match(postNav.output, /math2\.wasm/, "the new page's module must be loaded");
});
