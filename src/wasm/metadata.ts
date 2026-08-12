/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export type WasmDebugInfoHint = "dwarf" | "source-map";

/** Extract only custom-section names. Discovery deliberately receives compact
 * metadata instead of copying a potentially large module into every debugger
 * component. */
export function wasmCustomSectionNames(bytes: Uint8Array): string[] {
  if (bytes.length < WASM_HEADER.length || !WASM_HEADER.every((byte, i) => bytes[i] === byte)) {
    throw new Error("invalid WebAssembly header");
  }

  const names: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = WASM_HEADER.length;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const size = readU32(bytes, offset, bytes.length);
    const payloadStart = size.next;
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > bytes.length)
      throw new Error("WebAssembly section extends past end of module");

    if (sectionId === 0) {
      const nameLength = readU32(bytes, payloadStart, payloadEnd);
      const nameEnd = nameLength.next + nameLength.value;
      if (nameEnd > payloadEnd) {
        throw new Error("WebAssembly custom section name extends past end of section");
      }
      try {
        names.push(decoder.decode(bytes.subarray(nameLength.next, nameEnd)));
      } catch (error) {
        throw new Error("WebAssembly custom section name is not valid UTF-8", { cause: error });
      }
    }
    offset = payloadEnd;
  }
  return names;
}

/** Normalize format-specific custom sections into a small vocabulary suitable
 * for SourceDebuggerComponent ownership probes and a future WIT record. */
export function wasmDebugInfoHints(bytes: Uint8Array): WasmDebugInfoHint[] {
  const sections = wasmCustomSectionNames(bytes);
  const hints = new Set<WasmDebugInfoHint>();
  if (sections.some((name) => name.startsWith(".debug_") || name === "external_debug_info")) {
    hints.add("dwarf");
  }
  if (sections.includes("sourceMappingURL")) hints.add("source-map");
  return [...hints];
}

function readU32(bytes: Uint8Array, start: number, end: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  for (let offset = start; offset < end && offset < start + 5; offset++) {
    const byte = bytes[offset];
    const payload = byte & 0x7f;
    if (offset === start + 4 && payload > 0x0f) {
      throw new Error("WebAssembly u32 value is out of range");
    }
    value += payload * multiplier;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    multiplier *= 0x80;
  }
  throw new Error("invalid WebAssembly u32 encoding");
}
