/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP remains attached and rebinds a source breakpoint after navigation", async () => {
  session = await DAPFixtureSession.attach("navigation", {
    fire: "location.href = 'page2.html?dap=1'",
    configure: (dap, fixture) => dap.setSourceBreakpoints(fixture.file, [24]),
  });

  let stopped = session.stoppedEvent;
  for (let attempt = 0; attempt < 10; attempt++) {
    const stack = await session.requestOk("stackTrace", {
      threadId: stopped.body.threadId,
      startFrame: 0,
      levels: 1,
    });
    const frame = stack.body.stackFrames[0];
    if (/compute_factorial/.test(frame.name)) {
      assert.equal(frame.source.path.endsWith("math.cpp"), true);
      assert.equal(frame.line, 24);
      return;
    }
    stopped = await session.continueAndWait(stopped.body.threadId);
  }
  assert.fail("navigation did not reach the rebound source breakpoint");
});
