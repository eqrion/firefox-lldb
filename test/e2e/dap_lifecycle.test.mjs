/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP reports invalid attach cleanly and still disconnects", async () => {
  session = await DAPFixtureSession.attach("factorial", {
    attachCommands: ["process attach --plugin wasm --pid 999"],
    configure: null,
    expectAttachFailure: true,
    waitForStop: false,
  });
  assert.equal(session.attachResponse.success && session.configurationDoneResponse.success, false);
  assert.match(
    JSON.stringify([session.attachResponse, session.configurationDoneResponse]),
    /attach|process|pid|async thread/i
  );
  assert.equal(session.initializeResponse.body.supportsConfigurationDoneRequest, true);
  await session.disconnect();
});
