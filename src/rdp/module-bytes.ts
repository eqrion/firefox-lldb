/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker SAB transport has a 32 MiB data region. Leave room for wire
// metadata so an accepted module can actually cross that boundary.
export const MAX_MODULE_BYTES = 31 * 1024 * 1024;

export interface ModuleByteProvider {
  fetch(url: string): Promise<Uint8Array>;
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
  async fetch(url: string): Promise<Uint8Array> {
    const response = await globalThis.fetch(url, {
      headers: { "X-Firefox-Lldb": "module-fetch" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MODULE_BYTES) {
      throw new Error(`module is too large (${declaredLength} bytes)`);
    }
    if (!response.body) throw new Error("response has no body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_MODULE_BYTES) {
        await reader.cancel();
        throw new Error(`module is too large (more than ${MAX_MODULE_BYTES} bytes)`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!isWasmBinary(bytes)) throw new Error("response is not a WebAssembly binary");
    return bytes;
  }
}

export const defaultModuleByteProvider: ModuleByteProvider = new HttpModuleByteProvider();
