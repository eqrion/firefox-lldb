/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Spawned by session-log.test.ts to prove captureFatalErrors() records a
// crash before the process exits — process.exit() can't be exercised safely
// in-process, so this runs as a real child process.
//
// argv[2]: log file path
// argv[3]: "uncaughtException" | "unhandledRejection"

import { captureFatalErrors, openSessionLog } from "../../src/cli/session-log.js";

const [, , logPath, mode] = process.argv;
const sessionLog = openSessionLog(logPath!, process.argv.slice(2));
captureFatalErrors(sessionLog);

if (mode === "unhandledRejection") {
  Promise.reject(new Error("boom from helper"));
} else {
  throw new Error("boom from helper");
}
