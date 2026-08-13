/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerComponentHost } from "../protocol/component.js";
import type { ComponentId } from "../protocol/types.js";
import type { WasmDebuggee } from "../protocol/wasm-debuggee.js";

/** A component-scoped view of the session host. The component id is the
 * authority used by the target when it opens a WasmDebuggee resource. */
export interface SourceDebuggerComponentHostBinding extends SourceDebuggerComponentHost {
  readonly componentId: ComponentId;
}

/** Owns imported debuggee capabilities for one logical source-debugging
 * session. It deliberately knows nothing about Firefox RDP, GDB RSP, TCP, or
 * any particular source debugger engine. */
export class SourceDebuggerSessionHost {
  readonly #openWasmDebuggee: ((componentId: ComponentId) => Promise<WasmDebuggee>) | undefined;
  readonly #bindings = new Map<ComponentId, SourceDebuggerComponentHostBinding>();
  readonly #wasmDebuggees = new Set<WasmDebuggee>();
  #closed = false;

  constructor(
    options: {
      openWasmDebuggee?: (componentId: ComponentId) => Promise<WasmDebuggee>;
    } = {}
  ) {
    this.#openWasmDebuggee = options.openWasmDebuggee;
  }

  forComponent(componentId: ComponentId): SourceDebuggerComponentHostBinding {
    if (!componentId) throw new Error("SourceDebuggerComponent host binding requires an id");
    if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
    const existing = this.#bindings.get(componentId);
    if (existing) return existing;

    const binding: SourceDebuggerComponentHostBinding = {
      componentId,
      openWasmDebuggee: async (): Promise<WasmDebuggee> => {
        if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
        if (!this.#openWasmDebuggee) {
          throw new Error("SourceDebuggerSessionHost has no Wasm debuggee target");
        }
        const debuggee = await this.#openWasmDebuggee(componentId);
        if (this.#closed) {
          await debuggee.dispose().catch(() => {});
          throw new Error("SourceDebuggerSessionHost closed while opening a Wasm debuggee");
        }
        this.#wasmDebuggees.add(debuggee);
        return debuggee;
      },
    };
    this.#bindings.set(componentId, binding);
    return binding;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bindings.clear();
    for (const debuggee of this.#wasmDebuggees) void debuggee.dispose().catch(() => {});
    this.#wasmDebuggees.clear();
  }
}
