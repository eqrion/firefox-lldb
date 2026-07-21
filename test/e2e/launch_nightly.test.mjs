/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exercise the real --nightly launch path, including its cleanup. On macOS
// the Nightly launcher may exit while handing off to the browser process; the
// Firefox handle must subscribe to that exit before it can be missed, or
// shutdown hangs forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../../src/core/platform-session.ts";
import { findFirefoxBinary, launchFirefox } from "../../src/rdp/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeWithin(firefox, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Nightly shutdown timed out")), ms);
  });
  try {
    await Promise.race([firefox.close(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("--nightly launches and shuts down cleanly", async (t) => {
  if (!findFirefoxBinary("nightly")) {
    t.skip("Firefox Nightly is not installed");
    return;
  }

  const args = parseCliArgs([
    "--launch",
    "--nightly",
    "--headless",
    "--port",
    "0",
    "--rdp-port",
    String(await freePort()),
  ]);
  assert.equal(args.channel, "nightly");

  const firefox = await launchFirefox({
    rdpPort: args.rdpPort,
    channel: args.channel,
    headless: args.headless,
  });
  let closed = false;
  try {
    assert.ok(firefox.pid, "Nightly should have been launched");
    await verifyFirefoxLaunchToken(args.rdpPort, "127.0.0.1", firefox.launchToken);
    await closeWithin(firefox, 15_000);
    closed = true;
  } finally {
    if (!closed) {
      // Ensure the detached Firefox process does not leak into other e2e files.
      await Promise.race([firefox.close(), sleep(15_000)]);
    }
  }
});
