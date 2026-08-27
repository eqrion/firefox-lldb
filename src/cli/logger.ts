/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger } from "../logging.js";
import type { SessionLog } from "./session-log.js";

/** Console logger. Debug output is gated behind the `verbose` flag. */
export function consoleLogger(verbose: boolean): Logger {
  const stamp = (level: string, msg: string) => `[${level}] ${msg}`;
  return {
    debug: verbose ? (m) => console.error(stamp("debug", m)) : () => {},
    info: (m) => console.error(stamp("info", m)),
    warn: (m) => console.error(stamp("warn", m)),
    error: (m) => console.error(stamp("error", m)),
  };
}

/** Logger for the interactive embedding: drops the noisy [info] startup chatter
 * and keeps only warnings and errors. Debug is still gated behind `verbose`. */
export function quietLogger(verbose: boolean): Logger {
  const base = consoleLogger(verbose);
  return { ...base, info: () => {} };
}

/**
 * Build the logger for a CLI entry point. With a session log and `verbose`
 * off, debug output goes to the file instead of the terminal — `--log` alone
 * should not spam the prompt with wire traces. With `verbose` on, debug stays
 * on the console too; `sessionLog.captureStdio()` already mirrors it into the
 * file, so routing it there again would record it twice.
 */
export function createLogger(opts: {
  verbose: boolean;
  quiet: boolean;
  sessionLog?: SessionLog;
}): Logger {
  const base = opts.quiet ? quietLogger(opts.verbose) : consoleLogger(opts.verbose);
  if (!opts.sessionLog || opts.verbose) return base;
  return { ...base, debug: (m) => opts.sessionLog!.record("debug", m) };
}
