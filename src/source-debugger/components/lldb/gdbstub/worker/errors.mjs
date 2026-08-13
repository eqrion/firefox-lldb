/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The debuggee WIT interface exposes a closed error enum. JavaScript failures
// crossing the SAB-RPC boundary must therefore be translated to one of these
// tags; passing an arbitrary Error.message to jco only causes a second failure
// while lowering the result and hides the original exception.

export const DEBUGGEE_ERROR_TAGS = new Set([
  "invalid-entity",
  "invalid-pc",
  "invalid-frame",
  "unsupported-type",
  "mismatched-type",
  "non-wasm-frame",
  "alloc-failure",
  "breakpoint-update",
  "read-only",
  "out-of-bounds",
  "memory-grow-failure",
  "execution-trap",
]);

/**
 * Convert an exception from the asynchronous host projection to the closed
 * error enum accepted by the synchronous WIT import.
 *
 * @param {unknown} error
 * @returns {{message: string, tag: string, unexpected: boolean}}
 */
export function normalizeDebuggeeError(error) {
  const message = String(error?.message || error || "rpc failure");
  const candidate = typeof error?.payload === "string" ? error.payload : message;
  const expected = DEBUGGEE_ERROR_TAGS.has(candidate);
  return {
    message,
    tag: expected ? candidate : "invalid-entity",
    unexpected: !expected,
  };
}
