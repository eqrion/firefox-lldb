/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker SAB transport has a 32 MiB data region. Leave room for wire
// metadata so an accepted module can actually cross that boundary.
export const MAX_MODULE_BYTES = 31 * 1024 * 1024;

import { fetchBytes } from "./fetch.js";

export interface ModuleByteProvider {
  fetch(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export function isWasmBinary(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

/** Default out-of-band provider. Injectable so authenticated/browser-backed
 * acquisition can be supplied without coupling it to session state. */
export class HttpModuleByteProvider implements ModuleByteProvider {
  async fetch(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = await fetchBytes(url, {
      maxBytes: MAX_MODULE_BYTES,
      signal,
      headers: { "X-Firefox-Lldb": "module-fetch" },
    });
    if (!isWasmBinary(bytes)) throw new Error("response is not a WebAssembly binary");
    return bytes;
  }
}

export const defaultModuleByteProvider: ModuleByteProvider = new HttpModuleByteProvider();
