/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger } from "../logging.js";

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
