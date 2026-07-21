/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Multithreaded (pthreads / web workers) tests. Ported from
// test/e2e-python/test_threaded.py. Non-mutating tests share the session, then
// the final tests step and resume through pthread_join.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Session, continueUntilBreakpoint } from "./harness.mjs";

describe("threaded", () => {
  let s;
  before(async () => {
    s = await Session.stoppedAtBreakpoint("threaded");
  });
  after(async () => {
    await s?.shutdown();
  });

  test("thread list shows the main thread plus at least one pool worker", async () => {
    const res = await s.command("thread list");
    // Each thread appears on its own line starting with "thread #N"
    const threadLines = res.output.split("\n").filter((l) => /thread #\d/.test(l));
    assert.ok(threadLines.length >= 2, `expected >= 2 threads; thread list:\n${res.output}`);
  });

  test("breakpoint fires in matmul_threaded (frame0 is matmul_threaded)", async () => {
    const f0 = await s.topFrame();
    assert.match(f0.function, /matmul_threaded/);
    assert.equal(f0.file?.endsWith("matmul.cpp"), true);
  });

  test("nthreads parameter is readable and > 0", async () => {
    const nthreads = await s.variable(0, "nthreads");
    assert.equal(nthreads.valid, true);
    assert.ok(nthreads.signed > 0, `nthreads should be > 0, got ${nthreads.signed}`);
  });

  test("StepInstruction advances the PC inside matmul_threaded", async () => {
    const pcBefore = (await s.topFrame()).pc;
    assert.notEqual(pcBefore, "0x0");
    await s.stepInstruction();
    assert.notEqual((await s.state()).reason, "exited");
    const f0 = await s.topFrame();
    assert.notEqual(f0.pc, pcBefore, "PC did not advance");
    assert.match(f0.function, /matmul_threaded/);
  });

  test("workers resume and pthread_join completes", async () => {
    const breakpoint = await s.breakpointByName("get_result");
    assert.notEqual(Session.parseBreakpointId(breakpoint), null, breakpoint.output);

    await continueUntilBreakpoint(s);
    const f0 = await s.topFrame();
    assert.match(f0.function, /get_result/);
    assert.equal(f0.file?.endsWith("matmul.cpp"), true);
  });
});
