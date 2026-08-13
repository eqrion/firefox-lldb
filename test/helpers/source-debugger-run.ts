/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerRun } from "../../src/source-debugger/protocol/component.js";
import type {
  ComponentRunRequest,
  ComponentRunTermination,
  ComponentStop,
  PhysicalResumeRequest,
} from "../../src/source-debugger/protocol/types.js";

export interface TestSourceDebuggerRunHooks {
  waitForStop?(): Promise<ComponentStop>;
  waitForResume?(): Promise<PhysicalResumeRequest | undefined>;
  grantResume?(request: PhysicalResumeRequest): void | Promise<void>;
  rearmObserver?(): void | Promise<void>;
  terminate?(reason: ComponentRunTermination): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function testSourceDebuggerRun(
  request: ComponentRunRequest,
  hooks: TestSourceDebuggerRunHooks = {}
): SourceDebuggerRun {
  return {
    id: request.runId,
    role: request.role,
    waitForStop:
      hooks.waitForStop ??
      (async () => ({
        runId: request.runId,
        disposition: request.role === "driver" ? "accepted" : "synchronized",
        reason: { kind: request.action.kind === "continue" ? "breakpoint" : "step" },
      })),
    waitForResume: hooks.waitForResume ?? (async () => undefined),
    grantResume: async (resume) => hooks.grantResume?.(resume),
    rearmObserver: async () => hooks.rearmObserver?.(),
    terminate: async (reason) => hooks.terminate?.(reason),
    dispose: async () => hooks.dispose?.(),
  };
}
