/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
} from "../protocol/component.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import type { ComponentId } from "../protocol/types.js";

export interface SourceDebuggerComponentActivation {
  /** Optional text a frontend can present when every component is ready. */
  readyMessage?: string;
}

/** Lightweight installed definition retained by the catalog before a target
 * or debugger engine instance exists. */
export interface LoadedSourceDebuggerComponentDefinition extends SourceDebuggerComponentProbe {
  readonly definition: SourceDebuggerComponentDefinition;
  close(): void | Promise<void>;
}

/** One loaded, isolated debugger ecosystem. Runtime-specific extensions (for
 * example LLDB platform bootstrap) can add methods without changing what the
 * session or component catalog consumes. */
export interface LoadedSourceDebuggerComponent extends SourceDebuggerComponentProbe {
  readonly definition: SourceDebuggerComponentDefinition;
  readonly component: SourceDebuggerComponent;
  /** Connect the isolated engine to its configured debug target. Target and
   * engine-specific bootstrap stays inside the installed loader. */
  activate(): Promise<SourceDebuggerComponentActivation | void>;
  close(): void | Promise<void>;
}

/** Browser-facing installation seam. A loader chooses how to obtain and
 * isolate an engine; the session supplies only a component-scoped host binding. */
export interface SourceDebuggerComponentLoader<
  Runtime extends LoadedSourceDebuggerComponent = LoadedSourceDebuggerComponent,
> {
  readonly id: ComponentId;
  loadDefinition(): Promise<LoadedSourceDebuggerComponentDefinition>;
  instantiate(host: SourceDebuggerComponentHost): Promise<Runtime>;
}
