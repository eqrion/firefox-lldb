/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// PTHREAD_POOL_SIZE=0 means the first pthread target is created only after
// attach and after breakpoints have already been set. This exercises buffered
// breakpoint replay onto a brand-new worker, worker-local inspection, resume
// to a second breakpoint, and a second dynamically scheduled task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { continueUntilBreakpoint, Session } from "./harness.mjs";

async function assertCheckpoint(s, expectedId, expectedValue) {
  await continueUntilBreakpoint(s);
  const frame = await s.topFrame();
  assert.match(frame.function, /dynamic_checkpoint/);
  assert.equal(frame.file?.endsWith("dynamic.cpp"), true);

  const id = await s.variable(0, "((DynamicTask*)arg)->id");
  const value = await s.variable(0, "((DynamicTask*)arg)->value");
  assert.equal(id.valid, true);
  assert.equal(value.valid, true);
  assert.equal(id.signed, expectedId);
  assert.equal(value.signed, expectedValue);
}

async function assertComplete(s, expectedId, expectedResult) {
  await continueUntilBreakpoint(s);
  const frame = await s.topFrame();
  assert.match(frame.function, /dynamic_complete/);

  const id = await s.variable(0, "((DynamicTask*)arg)->id");
  const result = await s.variable(0, "((DynamicTask*)arg)->result");
  assert.equal(id.valid, true);
  assert.equal(result.valid, true);
  assert.equal(id.signed, expectedId);
  assert.equal(result.signed, expectedResult);
}

test("breakpoints replay to workers created after attach and survive reuse", async () => {
  const s = await Session.attach("threaded_dynamic");
  try {
    const before = await s.command("thread list");
    const beforeLines = before.output.split("\n").filter((line) => /thread #\d/.test(line));
    assert.equal(beforeLines.length, 1, `worker existed before first continue:\n${before.output}`);

    const checkpoint = await s.breakpointByLocation("dynamic.cpp", 24);
    const checkpointId = Session.parseBreakpointId(checkpoint);
    assert.notEqual(checkpointId, null, checkpoint.output);

    const complete = await s.breakpointByLocation("dynamic.cpp", 32);
    const completeId = Session.parseBreakpointId(complete);
    assert.notEqual(completeId, null, complete.output);

    await assertCheckpoint(s, 7, 7007);
    const withWorker = await s.command("thread list");
    const selected = withWorker.output.match(/\* thread #(\d+)/);
    assert.ok(selected, `no selected worker in:\n${withWorker.output}`);
    assert.notEqual(Number(selected[1]), 1);

    await assertComplete(s, 7, 7014);

    // Queue another task while stopped. It runs when the session resumes and
    // may reuse the existing web worker or create another target; either way,
    // both buffered breakpoint locations must remain live.
    // Do not await this while stopped: Firefox services the queued evaluation
    // only after the all-stop resumes, which the next continue does.
    void s.evaluate("runDynamic(8, 8008)");
    await assertCheckpoint(s, 8, 8008);
    await assertComplete(s, 8, 8016);

    const checkpointList = await s.command(`breakpoint list ${checkpointId}`);
    const completeList = await s.command(`breakpoint list ${completeId}`);
    assert.match(checkpointList.output, /hit count = 2/);
    assert.match(completeList.output, /hit count = 2/);
  } finally {
    await s.shutdown();
  }
});
