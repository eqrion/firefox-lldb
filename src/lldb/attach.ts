/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LLDBClient } from "lldb-wasm";
import { noopLogger, type Logger } from "../diagnostics/logger.js";

export const LLDB_FAILED_STATUS = 6;

/** Retry attach only when an observed page replacement invalidated that attempt.
 * The caller counts navigation after per-tab initialization, excluding its initial load. */
export async function attachLldb(
  client: Pick<LLDBClient, "sessionCommand" | "sessionState">,
  pid: number,
  {
    navigationRevision = () => 0,
    attempts = 4,
    logger = noopLogger,
    onRetry,
  }: {
    navigationRevision?: () => number;
    attempts?: number;
    logger?: Logger;
    onRetry?: (attempt: number) => void;
  } = {}
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const revision = navigationRevision();
    logger.debug(`[attach] started attempt=${attempt} navigation=${revision}`);
    const result = await client.sessionCommand(`process attach --plugin wasm --pid ${pid}`);
    let failure = (result.error || result.output).trim();
    if (result.status < LLDB_FAILED_STATUS) {
      const state = await client.sessionState();
      if (state.reason !== "none" && state.reason !== "exited") {
        logger.debug(`[attach] completed attempt=${attempt} reason=${state.reason}`);
        return (result.output + result.error).trimEnd();
      }
      failure = `process did not stop (state ${state.reason})`;
    }
    const replaced = navigationRevision() !== revision;
    logger.warn(`[attach] failed attempt=${attempt} targetReplaced=${replaced}: ${failure}`);
    if (!replaced || attempt === attempts)
      throw new Error(`process attach failed after ${attempt} attempt(s): ${failure}`);
    onRetry?.(attempt);
  }
  throw new Error("attach requires at least one attempt");
}
