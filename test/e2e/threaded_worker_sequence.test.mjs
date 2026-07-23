/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Advanced all-stop coverage: four pool workers begin blocked in futex waits.
// Returning from worker N's checkpoint releases worker N+1, producing a
// deterministic stop on four distinct workers. Every stop must interrupt the
// other futex-blocked workers, expose the triggering worker's locals, and then
// resume the whole pool without losing the next breakpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { continueUntilBreakpoint, Session } from "./harness.mjs";

test("ordered worker sequence survives repeated all-stop cycles", async () => {
  const s = await Session.attach("threaded", { fire: "runProbeSequence(4)" });
  try {
    const breakpoint = await s.breakpointByLocation("matmul.cpp", 40);
    const breakpointId = Session.parseBreakpointId(breakpoint);
    assert.notEqual(breakpointId, null, breakpoint.output);

    const stoppedThreads = new Set();
    for (let expectedId = 0; expectedId < 4; expectedId++) {
      await continueUntilBreakpoint(s);

      const frame = await s.topFrame();
      assert.match(frame.function, /worker_probe_checkpoint/);
      assert.equal(frame.file?.endsWith("matmul.cpp"), true);

      const id = await s.variable(0, "((ProbeTask*)arg)->id");
      const count = await s.variable(0, "((ProbeTask*)arg)->count");
      const value = await s.variable(0, "((ProbeTask*)arg)->value");
      assert.equal(id.valid, true);
      assert.equal(count.valid, true);
      assert.equal(value.valid, true);
      assert.equal(id.signed, expectedId);
      assert.equal(count.signed, 4);
      assert.equal(value.signed, 1000 + expectedId * 111);

      const threads = await s.command("thread list");
      assert.doesNotMatch(threads.output, /stop reason = signal 0/);
      const selected = threads.output.match(/\* thread #(\d+)/);
      assert.ok(selected, `no selected worker in:\n${threads.output}`);
      assert.notEqual(Number(selected[1]), 1, "worker breakpoint unexpectedly stopped thread #1");
      stoppedThreads.add(Number(selected[1]));
    }

    assert.equal(stoppedThreads.size, 4, `expected four worker tids, got ${[...stoppedThreads]}`);
    const list = await s.command(`breakpoint list ${breakpointId}`);
    assert.match(list.output, /hit count = 4/);
  } finally {
    await s.shutdown();
  }
});

test("a worker can instruction-step and resume to another worker breakpoint", async () => {
  const s = await Session.attach("threaded", { fire: "runProbeSequence(1)" });
  try {
    const checkpoint = await s.breakpointByLocation("matmul.cpp", 40);
    const checkpointId = Session.parseBreakpointId(checkpoint);
    assert.notEqual(checkpointId, null, checkpoint.output);

    const finished = await s.breakpointByLocation("matmul.cpp", 48);
    assert.notEqual(Session.parseBreakpointId(finished), null, finished.output);

    await continueUntilBreakpoint(s);
    const before = await s.topFrame();
    assert.match(before.function, /worker_probe_checkpoint/);

    await s.stepInstruction();
    const after = await s.topFrame();
    assert.match(after.function, /worker_probe_checkpoint/);
    assert.notEqual(after.pc, before.pc, "worker PC did not advance");

    await s.deleteBreakpoint(checkpointId);
    await continueUntilBreakpoint(s);
    const resumed = await s.topFrame();
    assert.match(resumed.function, /worker_probe_finished/);

    const id = await s.variable(0, "((ProbeTask*)arg)->id");
    const result = await s.variable(0, "((ProbeTask*)arg)->value");
    assert.equal(id.signed, 0);
    assert.equal(result.signed, 1000);
  } finally {
    await s.shutdown();
  }
});
