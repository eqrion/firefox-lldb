/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression test for issue #48. The fixture server supplies COOP/COEP on the
// initial response, so the pthread pool is created without a service-worker
// reload. A breakpoint in the pthread entry point must stop on a worker while
// leaving the all-stop session inspectable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { continueUntilBreakpoint, Session } from "./harness.mjs";

test("breakpoint in a pthread worker stops the whole session", async () => {
  const s = await Session.attach("threaded", { fire: "runWorkerBreakpoint()" });
  try {
    const breakpoint = await s.breakpointByName("multiply_rows");
    const breakpointId = Session.parseBreakpointId(breakpoint);
    assert.notEqual(breakpointId, null, breakpoint.output);
    await continueUntilBreakpoint(s);

    const frame = await s.topFrame();
    assert.match(frame.function, /multiply_rows/);
    assert.equal(frame.file?.endsWith("matmul.cpp"), true);
    assert.notEqual(frame.pc, "0x0");

    const threads = await s.command("thread list");
    assert.doesNotMatch(threads.output, /stop reason = signal 0/);

    const list = await s.command(`breakpoint list ${breakpointId}`);
    assert.match(list.output, /hit count = 1/);
  } finally {
    await s.shutdown();
  }
});
