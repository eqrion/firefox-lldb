/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exercise version discovery against a real Firefox. This covers the same RDP
// device actor used to gate both launched and --connect sessions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import {
  firefoxCompatibilityError,
  MAX_SUPPORTED_FIREFOX_MAJOR,
} from "../../src/rdp/firefox-compatibility.ts";
import { Session } from "./harness.mjs";

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
    // Reviewing a new Nightly advances the boundary; it must not disable the
    // review gate for the next major, even when CI bypasses runtime rejection.
    assert.match(
      firefoxCompatibilityError({
        ...runtime,
        version: `${MAX_SUPPORTED_FIREFOX_MAJOR + 1}.0a1`,
        major: MAX_SUPPORTED_FIREFOX_MAJOR + 1,
      }),
      /newer than/
    );
  } finally {
    await firefox.close();
  }
});

test("the first platform attach does not require a whole-session retry", async () => {
  const session = await Session.attach("factorial", {
    channel: process.env.E2E_FIREFOX_CHANNEL ?? "release",
    setupAttempts: 1,
  });
  try {
    assert.ok(session.topLevelGeneration() > 0);
  } finally {
    await session.shutdown();
  }
});
