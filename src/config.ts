/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Every environment-variable knob this project reads, in one place, so each
// is documented and typed once instead of wherever it happens to be needed.

/** -v / DEBUG=1: verbose debug logging across the CLI and RDP wire trace. */
export function debugEnvEnabled(): boolean {
  return process.env.DEBUG === "1";
}

/** SOURCE_DEBUGGER_TRACE=1: coordinator/runtime logs without full RDP/RSP wire noise.
 * Intended for diagnosing component handoff/barrier failures. */
export function sourceDebuggerTraceEnabled(): boolean {
  return process.env.SOURCE_DEBUGGER_TRACE === "1";
}

/** Marionette port for firefox-devtools-mcp's BiDi page driver. Default 2828. */
export function marionettePort(): number {
  const value = Number(process.env.FIREFOX_WASM_DEBUGGER_MARIONETTE_PORT ?? 2828);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `FIREFOX_WASM_DEBUGGER_MARIONETTE_PORT must be an integer from 1 to 65535, got ${String(
        process.env.FIREFOX_WASM_DEBUGGER_MARIONETTE_PORT
      )}`
    );
  }
  return value;
}

/** Directory to mirror each launched Firefox's stdout/stderr into, if set. */
export function firefoxLogDir(): string | undefined {
  return process.env.FIREFOX_WASM_DEBUGGER_LOG_DIR;
}
