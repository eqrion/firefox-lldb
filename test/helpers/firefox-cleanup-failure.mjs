/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Inject discovery failure in a separate process so the production scanner's
// failure path is exercised without affecting any other test or live browser.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { access, rm } from "node:fs/promises";
import { strict as assert } from "node:assert";

const original = childProcess.execFile;
childProcess.execFile = (file, args, options, callback) => {
  if (file === "/bin/ps") {
    queueMicrotask(() => callback(new Error("injected process-discovery failure")));
    return {};
  }
  return original(file, args, options, callback);
};
syncBuiltinESMExports();
const { launchFirefox } = await import("../../src/core/firefox.ts");
const { freePort } = await import("../../src/platform/gdb-server-spawner.ts");
const { noopLogger } = await import("../../src/diagnostics/logger.ts");
const records = [];
const firefox = await launchFirefox({
  binary: "/usr/bin/true",
  headless: true,
  rdpPort: await freePort(),
  logger: { ...noopLogger, error: (message) => records.push(message) },
});
try {
  await assert.rejects(firefox.close(), /injected process-discovery failure/);
  await access(firefox.profileDir);
  assert.ok(records.some((line) => line.includes("cleanup.failed")));
  console.log("cleanup rejected and retained its profile");
} finally {
  // This fixture launches only /usr/bin/true: no browser can own this profile.
  await rm(firefox.profileDir, { recursive: true, force: true });
}
