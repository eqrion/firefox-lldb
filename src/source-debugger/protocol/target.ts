/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentId, ModuleDescriptor } from "./types.js";
import type { WasmDebuggee } from "./wasm-debuggee.js";

export type UnownedModuleDescriptor = Omit<ModuleDescriptor, "owner">;

/** Browser-neutral physical target surface consumed by the session runtime.
 * Language engines receive target capabilities through their component host;
 * the broker only needs module discovery and sticky ownership bookkeeping. */
export interface SourceDebuggerTarget {
  modules(): Promise<UnownedModuleDescriptor[]>;
  assignModuleOwner?(moduleId: string, componentId: ComponentId): void;
  removeModuleOwner?(moduleId: string): void;
  moduleOwner?(moduleId: string): ComponentId | undefined;
  /** Open a component-scoped view of the physical Wasm machine. Target
   * implementations enforce module ownership before returning the resource. */
  openWasmDebuggee?(componentId: ComponentId): Promise<WasmDebuggee>;
  close(): void | Promise<void>;
}
