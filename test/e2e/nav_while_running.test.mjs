/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// When a navigation replaces the top-level target while LLDB is continuing,
// the replacement reuses the old tid. The all-stop listener for that tid must
// be reused too, rather than overwritten and leaked. A leaked listener makes
// later pauses look witnessed even though its already-fired callback ignores
// them.

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

test("navigation while continuing does not leave a stale pause listener", async () => {
  // The timer cannot run until LLDB resumes Firefox, ensuring the target swap
  // happens with armAllStop active.
  s.evaluate("setTimeout(() => assignPage2(), 0)");
  const continued = continueUntilBreakpoint(s);
  await sleep(1000);
  const trigger = setInterval(() => s.evaluate("runFactorial()"), 500);
  try {
    const st = await continued;
    assert.equal(st.reason, "breakpoint");
  } finally {
    clearInterval(trigger);
  }

  // Replace that target once more while LLDB is stopped. The new page can
  // then pause before the next continue, which must be recorded as unwitnessed.
  await s.navigate(s.pageUrl("page2.html"));
  await sleep(3000);
  s.evaluate("runFactorial()");
  for (let i = 0; i < 50 && !s.hasUnwitnessedPause(); i++) await sleep(100);
  assert.equal(
    s.hasUnwitnessedPause(),
    true,
    "the replacement target's pause must not be hidden by a stale listener"
  );

  // The first adopted stop is also the library-change notification for this
  // fresh module incarnation, which LLDB consumes internally while rebinding
  // the symbolic breakpoint. Keep driving the function until the rebound site
  // produces the user-visible stop.
  const resumed = s.continue();
  const retrigger = setInterval(() => s.evaluate("runFactorial()"), 500);
  try {
    await resumed;
  } finally {
    clearInterval(retrigger);
  }
  assert.equal((await s.state()).reason, "breakpoint");
});
