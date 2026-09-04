/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP reports the current wasm pause limitation cleanly", async () => {
  let threadId;
  session = await DAPFixtureSession.attach("threaded", {
    fire: "runInterruptWorkers(4)",
    waitForStop: false,
    attachCommands: [
      "settings set target.process.interrupt-timeout 2",
      "process attach --plugin wasm --pid 1",
    ],
    configure: async (dap) => {
      const threads = await dap.requestOk("threads");
      threadId = threads.body.threads[0].id;
    },
  });

  await sleep(500);
  // LLDB-DAP implements this request with SBProcess::Stop(). In lldb-wasm the
  // async halt path currently times out before sending an RSP interrupt; the
  // TUI's direct RDP interrupt hook remains the working path.
  const response = await session.request("pause", { threadId });
  assert.equal(response.success, false);
  assert.match(response.body.error.format, /Halt timed out/);
});
