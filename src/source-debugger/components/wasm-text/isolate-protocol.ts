/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerComponentWorkerPorts } from "../../transport/isolate.js";

export interface WasmTextIsolateWorkerData extends SourceDebuggerComponentWorkerPorts {
  options: {
    id: string;
    name: string;
  };
}

export type WasmTextIsolateMessage =
  | { type: "wasm-text-isolate-ready" }
  | {
      type: "wasm-text-isolate-initialization-error";
      error: { name: string; message: string; stack?: string };
    };
