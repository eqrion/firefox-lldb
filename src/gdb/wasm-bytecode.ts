/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const CUSTOM_SECTION_ID = 0;
const CODE_SECTION_ID = 10;
const EXTERNAL_DEBUG_INFO = "external_debug_info";

const decoder = new TextDecoder();

function readU32(bytes: Uint8Array, start: number, end = bytes.length) {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < end && offset < start + 5; offset++) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + 1 };
    shift += 7;
  }
  return null;
}

/** Read a length-prefixed UTF-8 string, as used for custom-section names. */
function readName(bytes: Uint8Array, start: number, end: number) {
  const length = readU32(bytes, start, end);
  if (!length || length.next + length.value > end) return null;
  return {
    value: decoder.decode(bytes.subarray(length.next, length.next + length.value)),
    next: length.next + length.value,
  };
}

interface WasmSection {
  id: number;
  /** Custom-section name, or "" for a known section. */
  name: string;
  /** Offset of the section id byte. */
  start: number;
  /** Offset of the section content: the name for a custom section. */
  contentStart: number;
  /** Offset immediately after the section. */
  end: number;
}

/** Split a module into its sections, or undefined if it is not a well-formed
 * wasm binary. Callers use the offsets to slice the original bytes, so nothing
 * is copied here. */
function wasmSections(bytes: Uint8Array): WasmSection[] | undefined {
  if (bytes.length < WASM_HEADER.length || !WASM_HEADER.every((byte, i) => bytes[i] === byte)) {
    return undefined;
  }

  const sections: WasmSection[] = [];
  let offset = WASM_HEADER.length;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const size = readU32(bytes, offset);
    if (!size) return undefined;
    const contentStart = size.next;
    const end = contentStart + size.value;
    if (end > bytes.length) return undefined;

    let name = "";
    if (id === CUSTOM_SECTION_ID) {
      const parsed = readName(bytes, contentStart, end);
      if (!parsed) return undefined;
      name = parsed.value;
    }
    sections.push({ id, name, start, contentStart, end });
    offset = end;
  }
  return sections;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface WasmFunctionRange {
  /** Offset of the function body's size field in the module bytecode. */
  start: number;
  /** Offset immediately after the encoded function body. */
  end: number;
}

/**
 * Return the encoded code-body range containing `offset`.
 *
 * Breakpoint addresses use module-file offsets. Keeping a snapped position in
 * this range prevents a function-entry breakpoint in a body header from moving
 * backward to the preceding function's final opcode.
 */
export function wasmFunctionRange(
  bytes: Uint8Array,
  targetOffset: number
): WasmFunctionRange | undefined {
  const code = wasmSections(bytes)?.find((section) => section.id === CODE_SECTION_ID);
  if (!code) return undefined;

  const count = readU32(bytes, code.contentStart, code.end);
  if (!count) return undefined;
  let bodyOffset = count.next;
  for (let i = 0; i < count.value; i++) {
    const bodyStart = bodyOffset;
    const bodySize = readU32(bytes, bodyOffset, code.end);
    if (!bodySize) return undefined;
    const bodyEnd = bodySize.next + bodySize.value;
    if (bodyEnd > code.end) return undefined;
    if (targetOffset >= bodyStart && targetOffset < bodyEnd) {
      return { start: bodyStart, end: bodyEnd };
    }
    bodyOffset = bodyEnd;
  }
  return undefined;
}

/**
 * Remove the `name` custom section.
 *
 * LLDB's wasm object reader maps names from that section as if its function
 * indices excluded imports. The wasm format includes imports in that index
 * space, so names after the imported functions are attached to the wrong code
 * addresses. DWARF already carries the authoritative function names and ranges,
 * so dropping the section prevents duplicate, incorrectly-addressed symbol
 * matches without touching executable code or debug sections.
 */
export function stripWasmNameSection(bytes: Uint8Array): Uint8Array {
  const sections = wasmSections(bytes);
  if (!sections || !sections.some((section) => section.name === "name")) return bytes;
  return concatBytes([
    bytes.subarray(0, WASM_HEADER.length),
    ...sections
      .filter((section) => section.name !== "name")
      .map((section) => bytes.subarray(section.start, section.end)),
  ]);
}

/**
 * Read the `external_debug_info` custom section: the path or URL of a companion
 * wasm file holding this module's DWARF (emscripten's `-gseparate-dwarf`).
 *
 * See https://yurydelendik.github.io/webassembly-dwarf/#external-DWARF.
 */
export function wasmExternalDebugInfo(bytes: Uint8Array): string | undefined {
  const section = wasmSections(bytes)?.find((s) => s.name === EXTERNAL_DEBUG_INFO);
  if (!section) return undefined;
  const name = readName(bytes, section.contentStart, section.end);
  if (!name) return undefined;
  return readName(bytes, name.next, section.end)?.value || undefined;
}
