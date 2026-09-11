/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wraps the pure-compute source-map/wasm metadata component on the main thread.
// Callers own fetching and materialization; this wrapper bounds compute inputs.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { instantiate } from "./generated/sourcemap.js";
import type {
  InspectResult,
  ConvertResult,
  ModuleValues,
} from "./generated/interfaces/firefox-lldb-source-map-source-map-converter.js";

const GEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "generated");
// Bound pure-compute inputs and output independently of the acquisition layer.
const MAX_MODULE_BYTES = 31 * 1024 * 1024;

// Node provides the WebAssembly global at runtime; the project's lib set
// (ES2023) doesn't declare it, so declare just the slice we use here.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

type Converter = {
  values(wasm: Uint8Array): ModuleValues;
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
    const initializing = (async () => {
      const root = await (instantiate as unknown as InstantiateFn)(
        async (corePath: string) => WebAssembly.compile(await readFile(path.join(GEN, corePath))),
        new WASIShim().getImportObject()
      );
      return root.sourceMapConverter;
    })();
    converterPromise = initializing;
    // Do not cache a rejected initialization forever. A package asset may be
    // restored or a transient read can succeed for the next module.
    void initializing.catch(() => {
      if (converterPromise === initializing) converterPromise = null;
    });
  }
  return converterPromise;
}

export async function inspect(wasm: Uint8Array): Promise<InspectResult> {
  if (wasm.length > MAX_MODULE_BYTES) throw new Error("module exceeds 31 MiB limit");
  return (await converter()).inspect(wasm);
}

export async function valueMetadata(wasm: Uint8Array): Promise<ModuleValues> {
  if (wasm.length > MAX_MODULE_BYTES) throw new Error("module exceeds 31 MiB limit");
  return (await converter()).values(wasm);
}

export async function convert(
  wasm: Uint8Array,
  sourceMap?: Uint8Array,
  compDir?: string
): Promise<ConvertResult> {
  if (wasm.length > MAX_MODULE_BYTES) throw new Error("module exceeds 31 MiB limit");
  if (sourceMap && sourceMap.length > MAX_MODULE_BYTES)
    throw new Error("source map exceeds 31 MiB limit");
  const result = (await converter()).convert(wasm, sourceMap, compDir);
  if (result.wasm.length > MAX_MODULE_BYTES)
    throw new Error("converted module exceeds 31 MiB limit");
  if (
    result.sources.length > 4096 ||
    result.sources.reduce((n, s) => n + s.content.length, 0) > 64 * 1024 * 1024
  )
    throw new Error("converted sources exceed 4096 files or 64 MiB limit");
  return result;
}
