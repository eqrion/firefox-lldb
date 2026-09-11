/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { captureFatalErrors, openSessionLog } from "../../src/diagnostics/session-log.js";
import { launchFirefox } from "../../src/core/firefox.js";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.js";
import { freePort } from "../../src/platform/gdb-server-spawner.js";

const log = openSessionLog(process.argv[2]!, []);
const port = await freePort();
const firefox = await launchFirefox({
  rdpPort: port,
  headless: true,
  binary: process.env.FIREFOX_BINARY,
});
captureFatalErrors(log, async () => {
  log.record("debug", "fatal browser cleanup started");
  await firefox.close();
  log.record("debug", "fatal browser cleanup completed");
});
await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
process.stdout.write(JSON.stringify({ pid: firefox.pid, profileDir: firefox.profileDir }));
throw new Error("deliberate fatal failure with an owned Firefox");
