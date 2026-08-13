/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
} from "../protocol/component.js";

export interface SourceDebuggerComponentActivation {
  /** Optional text a frontend can present when every component is ready. */
  readyMessage?: string;
}

/** One loaded, isolated debugger ecosystem. Runtime-specific extensions (for
 * example LLDB platform bootstrap) can add methods without changing what the
 * session or component catalog consumes. */
export interface SourceDebuggerComponentInstance {
  readonly component: SourceDebuggerComponent;
  /** Connect the isolated engine to its configured debug target. Target and
   * engine-specific bootstrap stays inside the installed loader. */
  activate(): Promise<SourceDebuggerComponentActivation | void>;
  close(): void | Promise<void>;
}

/** Host-facing installation seam. A loader chooses how to obtain and
 * isolate an engine; the session supplies only a component-scoped host binding. */
export interface SourceDebuggerComponentLoader<
  Instance extends SourceDebuggerComponentInstance = SourceDebuggerComponentInstance,
> {
  /** Lightweight discovery surface. Reading it must not instantiate a
   * debugger engine or connect to a target. */
  readonly definition: SourceDebuggerComponentDefinition;
  instantiate(host: SourceDebuggerComponentHost): Promise<Instance>;
}
