/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentHost,
} from "../../protocol/component.js";
import type {
  SourceDebuggerComponentInstance,
  SourceDebuggerComponentLoader,
} from "../../session/loader.js";
import { WASM_SOURCE_DEBUGGER_ID, wasmSourceDebuggerDefinition } from "./component.js";
import { IsolatedWasmTextComponentRuntime } from "./isolate.js";

export class WasmSourceDebuggerComponentLoader implements SourceDebuggerComponentLoader {
  readonly definition: SourceDebuggerComponentDefinition;
  readonly #id: string;

  constructor(
    id = WASM_SOURCE_DEBUGGER_ID,
    private readonly name = "WebAssembly Text"
  ) {
    this.#id = id;
    this.definition = wasmSourceDebuggerDefinition(this.#id, this.name);
  }

  async instantiate(host: SourceDebuggerComponentHost): Promise<SourceDebuggerComponentInstance> {
    const runtime = await IsolatedWasmTextComponentRuntime.create({
      host,
      id: this.#id,
      name: this.name,
    });
    let closed = false;
    return {
      component: runtime.component,
      activate: async () => ({}),
      close: async () => {
        if (closed) return;
        closed = true;
        await runtime.close();
      },
    };
  }
}
