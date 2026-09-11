/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { openSessionLog, formatErrorWithLog } from "../../src/diagnostics/session-log.js";

const [path, mode] = process.argv.slice(2);
const log = openSessionLog(path!, []);
const original = fs.writeSync;
let writes = 0;
// Fault injection stays in a child process and affects transcript fds only.
fs.writeSync = ((fd: number, ...args: unknown[]) => {
  if (fd <= 2) return Reflect.apply(original, fs, [fd, ...args]);
  writes++;
  if (mode === "failure" && writes > 1) throw new Error("ENOSPC: injected full disk");
  const [bytes, offset, length] = args as [Uint8Array, number, number];
  return original(fd, bytes, offset, Math.min(length, 7));
}) as typeof fs.writeSync;
syncBuiltinESMExports();

if (mode === "exit") {
  log.captureStdio();
  process.stderr.write("partial line at process exit");
  process.exit(0);
}
log.record("debug", "non-ASCII survives short writes: π 🎯");
log.flush();
log.record("debug", "tail survives disk failure");
const report = formatErrorWithLog(new Error("test failure"), log);
log.close({ remove: mode === "failure" });
process.stdout.write(JSON.stringify({ failure: log.failure, report, writes }));
