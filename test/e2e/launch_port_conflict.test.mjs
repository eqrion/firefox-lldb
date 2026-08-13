/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The supported CLI launch path must refuse a stale Firefox or other process
// on its requested RDP port instead of connecting to the wrong browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { parseCliArgs } from "../../src/cli/options.ts";
import { freePort } from "../../src/net/free-port.ts";
import { FirefoxSourceDebuggerTarget } from "../../src/source-debugger/target/firefox/target.ts";
import { findFirefoxBinary } from "../../src/source-debugger/target/firefox/rdp/firefox.ts";

test("the debugger refuses an occupied Firefox RDP port", async (t) => {
  if (!findFirefoxBinary()) {
    t.skip("Firefox is not installed");
    return;
  }

  const rdpPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(rdpPort, "127.0.0.1", resolve));
  try {
    const options = parseCliArgs(["--launch", "--headless", "--rdp-port", String(rdpPort)]);
    await assert.rejects(
      () => FirefoxSourceDebuggerTarget.start({ ...options }),
      /already listening/
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
