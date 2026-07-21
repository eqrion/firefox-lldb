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
import { parseCliArgs, startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { findFirefoxBinary } from "../../src/rdp/firefox.ts";

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

test("a platform-port bind failure rolls back the Firefox launch", async (t) => {
  if (!findFirefoxBinary()) {
    t.skip("Firefox is not installed");
    return;
  }
  const platformPort = await freePort();
  const rdpPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(platformPort, "127.0.0.1", resolve));
  try {
    const args = parseCliArgs([
      "--launch",
      "--headless",
      "--port",
      String(platformPort),
      "--rdp-port",
      String(rdpPort),
    ]);
    await assert.rejects(() => startPlatformServer(args), /EADDRINUSE|address already in use/i);

    // The detached child must be gone rather than surviving the rejected startup.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: rdpPort, host: "127.0.0.1" }, () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      })
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
