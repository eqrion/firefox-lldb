/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../diagnostics/logger.js";

/** Protocol/schema failures cannot be repaired by reconnecting. */
export function isTransientConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(String(error.code))
  );
}

/** One deadline covers connection attempts, initialization and retry delays. */
export async function withRdpStartupRetry<T>(
  acquire: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; logger?: Logger; attempts?: number; timeoutMs?: number } = {}
): Promise<T> {
  const { signal, logger, attempts = 80, timeoutMs = 20_000 } = options;
  signal?.throwIfAborted();
  const abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => abort.abort(new Error(`Firefox RDP startup timed out after ${timeoutMs} ms`)),
    timeoutMs
  );
  let last: unknown;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      abort.signal.throwIfAborted();
      try {
        return await acquire(abort.signal);
      } catch (error) {
        abort.signal.throwIfAborted();
        if (!isTransientConnectionError(error)) throw error;
        last = error;
        logger?.debug(`[rdp] startup retry attempt=${attempt} error=${String(error)}`);
        if (attempt < attempts) await delay(250, undefined, { signal: abort.signal });
      }
    }
    throw new Error(`Firefox RDP startup exhausted ${attempts} connection attempts`, {
      cause: last,
    });
  } catch (error) {
    abort.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
