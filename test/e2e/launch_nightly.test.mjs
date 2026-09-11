/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exercise the real --nightly launch path, including its cleanup. On macOS
// the Nightly launcher may exit while handing off to the browser process; the
// Firefox handle must subscribe to that exit before it can be missed, or
// shutdown hangs forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseCliArgs } from "../../src/cli/options.ts";
import { findFirefoxBinary, launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { tracingLogger } from "./harness.mjs";

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
  const trace = tracingLogger();
  t.after(() => trace.close());

  const firefox = await launchFirefox({
    rdpPort: args.rdpPort,
    channel: args.channel,
    headless: args.headless,
    logger: trace,
  });
  let closed = false;
  try {
    assert.ok(firefox.pid, "Nightly should have been launched");
    await verifyFirefoxLaunchToken(args.rdpPort, "127.0.0.1", firefox.launchToken);
    await closeWithin(firefox, 15_000);
    closed = true;
  } finally {
    if (!closed) {
      // close() has its own bounded group/direct-PID SIGKILL fallback. Retain
      // this outer guard so the test also catches regressions in that bound.
      await closeWithin(firefox, 15_000).catch(() => {});
    }
    if (process.platform !== "win32") {
      const snapshot = execFileSync("/bin/ps", ["-ax", "-ww", "-o", "pid=,args="], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const survivors = snapshot
        .split("\n")
        .filter((line) =>
          line.includes(`--profile ${firefox.profileDir} --start-debugger-server ${args.rdpPort} `)
        );
      assert.deepEqual(
        survivors,
        [],
        `test Firefox survived cleanup; transcript: ${trace.logPath}`
      );
    }
  }
});
