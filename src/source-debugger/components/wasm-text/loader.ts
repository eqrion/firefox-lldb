/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerComponentHostBinding } from "../../target/host.js";
import type {
  LoadedSourceDebuggerComponent,
  LoadedSourceDebuggerComponentDefinition,
  SourceDebuggerComponentLoader,
} from "../../session/loader.js";
import {
  WASM_SOURCE_DEBUGGER_ID,
  probeWasmSourceDebuggerModule,
  wasmSourceDebuggerDefinition,
} from "./component.js";
import { IsolatedWasmTextComponentRuntime } from "./isolate.js";

export class WasmSourceDebuggerComponentLoader implements SourceDebuggerComponentLoader {
  readonly id: string;

  constructor(
    id = WASM_SOURCE_DEBUGGER_ID,
    private readonly name = "WebAssembly Text"
  ) {
    this.id = id;
  }

  async loadDefinition(): Promise<LoadedSourceDebuggerComponentDefinition> {
    const definition = wasmSourceDebuggerDefinition(this.id, this.name);
    return {
      id: this.id,
      definition,
      probeModule: definition.probeModule,
      close: () => {},
    };
  }

  async instantiate(
    host: SourceDebuggerComponentHostBinding
  ): Promise<LoadedSourceDebuggerComponent> {
    const runtime = await IsolatedWasmTextComponentRuntime.create({
      host,
      id: this.id,
      name: this.name,
    });
    let closed = false;
    return {
      id: this.id,
      definition: runtime.definition,
      component: runtime.component,
      probeModule: probeWasmSourceDebuggerModule,
      activate: async () => ({}),
      close: async () => {
        if (closed) return;
        closed = true;
        await runtime.close();
      },
    };
  }
}
