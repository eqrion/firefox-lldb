/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "./component.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import type { ComponentId } from "./types.js";

/** One loaded, isolated debugger ecosystem. Runtime-specific extensions (for
 * example LLDB platform bootstrap) can add methods without changing what the
 * session or component catalog consumes. */
export interface LoadedSourceDebuggerComponent extends SourceDebuggerComponentProbe {
  readonly definition: SourceDebuggerComponentDefinition;
  readonly component: SourceDebuggerComponentInstance;
  close(): void | Promise<void>;
}

/** Browser-facing installation seam. A loader chooses how to obtain and
 * isolate an engine; the session supplies only a component-scoped host binding. */
export interface SourceDebuggerComponentLoader<
  Runtime extends LoadedSourceDebuggerComponent = LoadedSourceDebuggerComponent,
> {
  readonly id: ComponentId;
  load(host: SourceDebuggerComponentHostBinding): Promise<Runtime>;
}
