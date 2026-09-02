/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exercise version discovery against a real Firefox. This covers the same RDP
// device actor used to gate both launched and --connect sessions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchFirefox } from "../../src/rdp/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { firefoxCompatibilityError } from "../../src/rdp/firefox-compatibility.ts";

test("detects the launched Firefox version over RDP", async () => {
  const rdpPort = await freePort();
  const firefox = await launchFirefox({
    rdpPort,
    binary: process.env.FIREFOX_BINARY,
    headless: true,
  });
  try {
    const runtime = await verifyFirefoxLaunchToken(rdpPort, "127.0.0.1", firefox.launchToken);
    assert.match(runtime.version, /^\d+/);
    assert.ok(Number.isInteger(runtime.major));
    assert.equal(runtime.channel, process.env.E2E_FIREFOX_CHANNEL ?? runtime.channel);
    assert.equal(
      firefoxCompatibilityError(runtime),
      undefined,
      "CI bypasses the runtime gate to exercise new builds, but the validated range still needs review"
    );
  } finally {
    await firefox.close();
  }
});
