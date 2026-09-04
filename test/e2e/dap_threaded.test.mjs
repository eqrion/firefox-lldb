/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP identifies the pthread that hits a worker breakpoint", async () => {
  session = await DAPFixtureSession.attach("threaded", {
    fire: "runProbeSequence(1)",
    configure: (dap) => dap.setFunctionBreakpoints(["worker_probe_checkpoint"]),
  });
  const threadId = session.stoppedEvent.body.threadId;
  assert.ok(threadId);

  const threads = await session.requestOk("threads");
  assert.ok(threads.body.threads.length > 1, JSON.stringify(threads));
  assert.ok(threads.body.threads.some((thread) => thread.id === threadId));

  const stack = await session.requestOk("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 20,
  });
  assert.match(stack.body.stackFrames[0].name, /worker_probe_checkpoint/);

  const continuedEvent = session.waitForEvent("continued");
  await session.requestOk("continue", { threadId });
  assert.equal((await continuedEvent).body.threadId, threadId);
});
