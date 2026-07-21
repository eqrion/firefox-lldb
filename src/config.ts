/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Every environment-variable knob this project reads, in one place, so each
// is documented and typed once instead of wherever it happens to be needed.

/** -v / DEBUG=1: verbose debug logging across the CLI, server, and RDP wire trace. */
export function debugEnvEnabled(): boolean {
  return process.env.DEBUG === "1";
}

/**
 * Exit cleanly once reparented to init/launchd (ppid 1). Set by the e2e
 * harness, which launches the server session-detached (setsid), so a killed
 * parent delivers no signal we'd otherwise catch — without this the launched
 * Firefox is orphaned.
 */
export function exitWhenOrphaned(): boolean {
  return !!process.env.FIREFOX_LLDB_EXIT_WHEN_ORPHANED;
}

/** Marionette port for firefox-devtools-mcp's BiDi page driver. Default 2828. */
export function marionettePort(): number {
  const value = Number(process.env.FIREFOX_LLDB_MARIONETTE_PORT ?? 2828);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `FIREFOX_LLDB_MARIONETTE_PORT must be an integer from 1 to 65535, got ${String(
        process.env.FIREFOX_LLDB_MARIONETTE_PORT
      )}`
    );
  }
  return value;
}

/** Directory to mirror each launched Firefox's stdout/stderr into, if set. */
export function firefoxLogDir(): string | undefined {
  return process.env.FIREFOX_LLDB_LOG_DIR;
}
