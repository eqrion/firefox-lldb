/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stale Firefox left over from a prior run can end up squatting on the RDP
// port; without a check, a later `--launch` silently connects its RDP client
// to that stale instance instead of the one it just spawned. Confirms
// launchFirefox refuses up front when the port is already occupied.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { parseCliArgs, startPlatformServer } from "../../src/cli/firefox-lldb-server.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";

test("launch refuses when the RDP port is already occupied", async () => {
  const rdpPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(rdpPort, "127.0.0.1", resolve));
  try {
    const args = parseCliArgs([
      "--launch",
      "--headless",
      "--port",
      "0",
      "--rdp-port",
      String(rdpPort),
    ]);
    await assert.rejects(() => startPlatformServer(args), /already listening/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
