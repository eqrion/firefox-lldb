/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Host glue for the source-map -> DWARF converter wasm component. The component
// is pure compute (no host imports beyond WASI), so we instantiate it once on
// the main thread and call its exports directly. The host is responsible for
// fetching the wasm and source map and materializing the returned sources.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { instantiate } from "./generated/sourcemap.js";
import type {
  InspectResult,
  ConvertResult,
} from "./generated/interfaces/firefox-lldb-source-map-source-map-converter.js";

const GEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "generated");

// Node provides the WebAssembly global at runtime; the project's lib set
// (ES2023) doesn't declare it, so declare just the slice we use here.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

type Converter = {
  inspect(wasm: Uint8Array): InspectResult;
  convert(
    wasm: Uint8Array,
    sourceMap: Uint8Array | undefined,
    compDir: string | undefined
  ): ConvertResult;
};

// The generated component is excluded from typechecking and its ImportObject
// type is stricter than WASIShim's; treat the instantiate boundary loosely.
type InstantiateFn = (
  getCoreModule: (path: string) => Promise<object>,
  imports: object
) => Promise<{ sourceMapConverter: Converter }>;

let converterPromise: Promise<Converter> | null = null;

async function converter(): Promise<Converter> {
  if (!converterPromise) {
    converterPromise = (async () => {
      const root = await (instantiate as unknown as InstantiateFn)(
        async (corePath: string) => WebAssembly.compile(await readFile(path.join(GEN, corePath))),
        new WASIShim().getImportObject()
      );
      return root.sourceMapConverter;
    })();
  }
  return converterPromise;
}

export async function inspect(wasm: Uint8Array): Promise<InspectResult> {
  return (await converter()).inspect(wasm);
}

export async function convert(
  wasm: Uint8Array,
  sourceMap?: Uint8Array,
  compDir?: string
): Promise<ConvertResult> {
  return (await converter()).convert(wasm, sourceMap, compDir);
}
