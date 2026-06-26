/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds a synthetic wasm module containing DWARF v4 that maps source line L
// to DWARF address L (identity). Used to represent JS sources as wasm modules
// so LLDB can symbolicate JS frames in an interleaved JS+wasm call stack.
//
// Address convention: LLDB subtracts the code section's file offset
// (codeOffset) from a raw PC to obtain the DWARF address. JS frames therefore
// report pc = where.line + codeOffset so that LLDB recovers address = where.line.

export interface SyntheticModule {
  bytecode: Uint8Array;
  // File offset within bytecode where the code section content starts.
  codeOffset: number;
}

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function cstr(s: string): number[] {
  return [...new TextEncoder().encode(s), 0];
}

function wasmSection(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function customSection(name: string, payload: number[]): number[] {
  const enc = new TextEncoder().encode(name);
  return wasmSection(0, [...uleb(enc.length), ...enc, ...payload]);
}

function debugAbbrev(): number[] {
  return [
    // Abbrev 1: DW_TAG_compile_unit (0x11), has children
    ...uleb(1),
    ...uleb(0x11),
    0x01,
    ...uleb(0x25),
    ...uleb(0x08), // DW_AT_producer,  DW_FORM_string
    ...uleb(0x13),
    ...uleb(0x05), // DW_AT_language,  DW_FORM_data2
    ...uleb(0x03),
    ...uleb(0x08), // DW_AT_name,      DW_FORM_string
    ...uleb(0x1b),
    ...uleb(0x08), // DW_AT_comp_dir,  DW_FORM_string
    ...uleb(0x11),
    ...uleb(0x01), // DW_AT_low_pc,    DW_FORM_addr
    ...uleb(0x12),
    ...uleb(0x01), // DW_AT_high_pc,   DW_FORM_addr
    ...uleb(0x10),
    ...uleb(0x17), // DW_AT_stmt_list, DW_FORM_sec_offset
    0x00,
    0x00,
    // Abbrev 2: DW_TAG_subprogram (0x2e), no children
    ...uleb(2),
    ...uleb(0x2e),
    0x00,
    ...uleb(0x03),
    ...uleb(0x08), // DW_AT_name,    DW_FORM_string
    ...uleb(0x11),
    ...uleb(0x01), // DW_AT_low_pc,  DW_FORM_addr
    ...uleb(0x12),
    ...uleb(0x01), // DW_AT_high_pc, DW_FORM_addr
    0x00,
    0x00,
    0x00, // end of abbreviation table
  ];
}

function debugInfo(
  name: string,
  compDir: string,
  lineCount: number,
  subprogramName: string
): number[] {
  const body: number[] = [
    0x01, // abbrev 1 = compile_unit
    ...cstr("firefox-lldb"), // DW_AT_producer
    ...u16le(0x000c), // DW_AT_language = DW_LANG_C99
    ...cstr(name), // DW_AT_name
    ...cstr(compDir), // DW_AT_comp_dir
    ...u32le(1), // DW_AT_low_pc
    ...u32le(lineCount + 1), // DW_AT_high_pc (exclusive)
    ...u32le(0), // DW_AT_stmt_list = 0
    // child: subprogram
    0x02, // abbrev 2 = subprogram
    ...cstr(subprogramName), // DW_AT_name (JS function name, or file name as fallback)
    ...u32le(1), // DW_AT_low_pc
    ...u32le(lineCount + 1), // DW_AT_high_pc
    0x00, // end of children
  ];
  // v4 CU header: unit_length(4) + version(2) + abbrev_offset(4) + addr_size(1) = 11 bytes
  // unit_length counts from after the length field: 2+4+1 + body.length
  const unitLength = 2 + 4 + 1 + body.length;
  return [
    ...u32le(unitLength),
    ...u16le(4), // version
    ...u32le(0), // debug_abbrev_offset
    0x04, // address_size = 4 (wasm32)
    ...body,
  ];
}

function debugLine(name: string, lineCount: number): number[] {
  // line_base=-5, line_range=14, opcode_base=13
  // special opcode for (addr_advance=1, line_advance=1):
  //   = opcode_base + (line_advance - line_base) + addr_advance * line_range
  //   = 13 + (1 - (-5)) + 1*14 = 13 + 6 + 14 = 33 = 0x21
  const lineBase = -5;
  const lineRange = 14;
  const opcodeBase = 13;
  const specialOpcode = opcodeBase + (1 - lineBase) + 1 * lineRange; // 33

  const fileEntry = [...cstr(name), 0x00, 0x00, 0x00]; // dir_idx=0 mtime=0 len=0

  // Header content (everything after the header_length field):
  const headerContent: number[] = [
    0x01, // minimum_instruction_length
    0x01, // maximum_operations_per_instruction (required v4)
    0x01, // default_is_stmt
    lineBase & 0xff, // line_base as signed byte
    lineRange, // line_range
    opcodeBase, // opcode_base
    // standard_opcode_lengths for opcodes 1-12:
    0,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    1,
    0x00, // include_directories terminator
    ...fileEntry,
    0x00, // file_names terminator
  ];

  // Line number program:
  // DW_LNE_set_address(1)
  const setAddr1 = [0x00, 0x05, 0x02, ...u32le(1)];
  // DW_LNS_set_prologue_end (0x0a), DW_LNS_copy (0x01) → emit (addr=1, line=1)
  // Then (lineCount-1) special opcodes: addr+1, line+1, emit
  // DW_LNE_end_sequence (0x00 0x01 0x01)
  const safeLineCount = Math.max(lineCount, 1);
  const program: number[] = [
    ...setAddr1,
    0x0a, // DW_LNS_set_prologue_end
    0x01, // DW_LNS_copy → emit row (addr=1, line=1)
    ...new Array(safeLineCount - 1).fill(specialOpcode),
    0x00,
    0x01,
    0x01, // DW_LNE_end_sequence
  ];

  const body = [...headerContent, ...program];
  // v4 header: unit_length(4) + version(2) + header_length(4) + body
  // unit_length = 2 + 4 + body.length; header_length = headerContent.length
  return [
    ...u32le(2 + 4 + body.length), // unit_length
    ...u16le(4), // version
    ...u32le(headerContent.length), // header_length
    ...body,
  ];
}

export function buildSyntheticModule(opts: {
  name: string;
  compDir: string;
  lineCount: number;
  /** JS function name to use as the DWARF subprogram name; falls back to `name`. */
  subprogramName?: string;
}): SyntheticModule {
  const { name, compDir, lineCount, subprogramName } = opts;
  const safeLineCount = Math.max(lineCount, 1);

  // Code section body: 0x00 (no locals) + (safeLineCount+1) NOPs + 0x0b (end)
  const bodyContent = [0x00, ...new Array(safeLineCount + 1).fill(0x01), 0x0b];
  const bodySize = uleb(bodyContent.length);
  const codeSectionPayload = [0x01, ...bodySize, ...bodyContent]; // count=1

  // Build leading sections to compute codeOffset
  const magic = [0x00, 0x61, 0x73, 0x6d];
  const version = [0x01, 0x00, 0x00, 0x00];
  const typeSection = wasmSection(1, [0x01, 0x60, 0x00, 0x00]); // () -> ()
  const funcSection = wasmSection(3, [0x01, 0x00]); // func 0: type 0
  const codeSectionSizeUleb = uleb(codeSectionPayload.length);
  // codeOffset = magic + version + typeSection + funcSection + code_id(1) + code_size_uleb
  const codeOffset =
    magic.length +
    version.length +
    typeSection.length +
    funcSection.length +
    1 +
    codeSectionSizeUleb.length;

  const codeSection = [0x0a, ...codeSectionSizeUleb, ...codeSectionPayload];

  const abbrev = debugAbbrev();
  const info = debugInfo(name, compDir, safeLineCount, subprogramName ?? name);
  const line = debugLine(name, safeLineCount);

  const bytes = new Uint8Array([
    ...magic,
    ...version,
    ...typeSection,
    ...funcSection,
    ...codeSection,
    ...customSection(".debug_abbrev", abbrev),
    ...customSection(".debug_info", info),
    ...customSection(".debug_line", line),
  ]);

  return { bytecode: bytes, codeOffset };
}
