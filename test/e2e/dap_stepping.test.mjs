/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

async function topStack(dap, threadId) {
  return (
    await dap.requestOk("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 20,
    })
  ).body.stackFrames;
}

test("DAP stepIn, stepOut, and next preserve source-level state", async () => {
  session = await DAPFixtureSession.attach("factorial");
  const threads = await session.requestOk("threads");
  const threadId = threads.body.threads[0].id;

  const before = await topStack(session, threadId);
  assert.match(before[0].name, /compute_factorial/);

  const steppedIn = await session.stepAndWait("stepIn", threadId);
  assert.equal(steppedIn.body.reason, "step");
  const inside = await topStack(session, threadId);
  assert.match(inside[0].name, /factorial/);
  assert.ok(inside.length > before.length);

  const lineBeforeNext = inside[0].line;
  await session.stepAndWait("next", threadId);
  const afterNext = await topStack(session, threadId);
  assert.notEqual(afterNext[0].line, lineBeforeNext);

  const steppedOut = await session.stepAndWait("stepOut", threadId);
  assert.equal(steppedOut.body.reason, "step");
  const outside = await topStack(session, threadId);
  assert.ok(outside.length > 0);
  assert.equal(outside[0].source.path.endsWith("math.cpp"), true);
});
