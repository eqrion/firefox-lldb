/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP reports the current running-disconnect limitation cleanly", async () => {
  session = await DAPFixtureSession.attach("factorial", {
    attachCommands: [
      "settings set target.process.interrupt-timeout 2",
      "process attach --plugin wasm --pid 1",
    ],
  });
  const threadId = session.stoppedEvent.body.threadId;
  await session.setFunctionBreakpoints([]);

  const continued = session.waitForEvent("continued");
  await session.requestOk("continue", { threadId });
  assert.equal((await continued).body.threadId, threadId);

  // Like pause, detaching a running target currently depends on LLDB's async
  // interrupt path, which does not reach the wasm RSP bridge.
  const response = await session.disconnect({ allowFailure: true });
  assert.equal(response.success, false);
  assert.match(
    response.body.error.format,
    /(?:disconnect packet failed|stop the target.*timed out)/i
  );
});
