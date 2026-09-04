/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

async function topFrame(dap, threadId) {
  const stack = await dap.requestOk("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 1,
  });
  return stack.body.stackFrames[0];
}

test("DAP instruction-steps a pthread then reaches its next breakpoint", async () => {
  session = await DAPFixtureSession.attach("threaded", {
    fire: "runProbeSequence(1)",
    configure: async (dap, fixture) => {
      const response = await dap.setSourceBreakpoints(fixture.file, [40, 48]);
      assert.ok(response.body.breakpoints.every((breakpoint) => breakpoint.verified));
    },
  });

  const threadId = session.stoppedEvent.body.threadId;
  const before = await topFrame(session, threadId);
  assert.match(before.name, /worker_probe_checkpoint/);

  await session.stepAndWait("next", threadId, { granularity: "instruction" });
  const after = await topFrame(session, threadId);
  assert.notEqual(after.instructionPointerReference, before.instructionPointerReference);

  const finished = await session.setSourceBreakpoints(session.fixture.file, [48]);
  assert.equal(finished.body.breakpoints[0].verified, true, JSON.stringify(finished));
  const stopped = await session.continueAndWait(threadId);
  const finalFrame = await topFrame(session, stopped.body.threadId);
  assert.match(finalFrame.name, /worker_probe_finished/);
});
