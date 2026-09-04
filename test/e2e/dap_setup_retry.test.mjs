/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP setup cleans up a pending attach before retrying", async () => {
  let attempts = 0;
  session = await DAPFixtureSession.attach("factorial", {
    configure: async (dap, fixture) => {
      attempts++;
      const response = await dap.setFunctionBreakpoints([fixture.breakFunc]);
      if (attempts === 1) throw new Error("intentional setup failure with attach pending");
      assert.equal(response.body.breakpoints[0].verified, true, JSON.stringify(response));
    },
  });

  assert.equal(attempts, 2);
  assert.equal(session.stoppedEvent.body.reason, "breakpoint");
});
