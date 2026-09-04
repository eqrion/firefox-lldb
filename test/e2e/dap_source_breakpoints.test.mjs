/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP source breakpoint resolves and stops at math.cpp:24", async () => {
  session = await DAPFixtureSession.attach("factorial", {
    configure: async (dap, fixture) => {
      const response = await dap.setSourceBreakpoints(fixture.file, [24]);
      assert.equal(response.body.breakpoints[0].verified, true, JSON.stringify(response));
      assert.equal(response.body.breakpoints[0].line, 24);
    },
  });

  assert.equal(session.stoppedEvent.body.reason, "breakpoint");
  const threads = await session.requestOk("threads");
  const stack = await session.requestOk("stackTrace", {
    threadId: threads.body.threads[0].id,
    startFrame: 0,
    levels: 1,
  });
  const frame = stack.body.stackFrames[0];
  assert.match(frame.name, /compute_factorial/);
  assert.equal(frame.source.path.endsWith("math.cpp"), true);
  assert.equal(frame.line, 24);
});
