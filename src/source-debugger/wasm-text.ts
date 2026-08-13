/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { print } from "@bytecodealliance/jco-transpile/wasm-tools";
import { wasmFunctionRanges, type WasmFunctionRange } from "../gdb/wasm-bytecode.js";

interface TextFunction {
  headerLine: number;
  instructionLines: number[];
  range: WasmFunctionRange;
  reference?: string;
}

export interface GeneratedWasmText {
  content: string;
  offsetForLine(line: number): number | undefined;
  lineForOffset(offset: number): number | undefined;
  offsetForFunction(name: string): number | undefined;
  functionForOffset(offset: number): string | undefined;
  rangeForOffset(offset: number): WasmFunctionRange | undefined;
}

/** Print canonical Wasm text and associate its instruction lines with the
 * exact byte offsets Firefox accepts as breakpoint locations. Firefox returns
 * a sparse subset of expression-ending operators, so each offset is matched
 * to the opcode mnemonic on the corresponding WAT line rather than assigned
 * to the first N printed instructions. */
export async function generateWasmText(
  bytecode: Uint8Array,
  breakpointOffsets: readonly number[]
): Promise<GeneratedWasmText> {
  const lines = (await print(bytecode)).split("\n");
  const ranges = wasmFunctionRanges(bytecode);
  const functions = textFunctions(lines, ranges);
  const offsetByLine = new Map<number, number>();
  const lineByOffset = new Map<number, number>();
  const functionByReference = new Map<string, TextFunction>();
  const offsetByFunction = new Map<string, number>();
  const functionNameByRange = new Map<WasmFunctionRange, string>();

  for (const fn of functions) {
    const positions = breakpointOffsets.filter(
      (offset) => offset >= fn.range.start && offset < fn.range.end
    );
    let lineCursor = 0;
    for (const offset of positions) {
      const mnemonic = opcodeMnemonic(bytecode, offset);
      const instructionIndex =
        mnemonic === undefined
          ? -1
          : fn.instructionLines.findIndex(
              (line, index) => index >= lineCursor && lineMnemonic(lines[line - 1]) === mnemonic
            );
      // Unknown proposal opcodes remain visible but unannotated. Guessing a
      // line would create a breakpoint which silently targets another opcode.
      if (instructionIndex < 0) continue;
      lineCursor = instructionIndex + 1;
      const line = fn.instructionLines[instructionIndex];
      offsetByLine.set(line, offset);
      lineByOffset.set(offset, line);
      lines[line - 1] += ` ;; @0x${offset.toString(16)}`;
    }
    if (positions[0] !== undefined) {
      offsetByLine.set(fn.headerLine, positions[0]);
      lines[fn.headerLine - 1] += ` ;; entry @0x${positions[0].toString(16)}`;
    }
    if (fn.reference) functionByReference.set(fn.reference, fn);
  }

  for (const fn of functions) {
    if (!fn.reference) continue;
    const name = referenceName(fn.reference);
    const offset = offsetByLine.get(fn.headerLine);
    if (name && offset !== undefined) {
      offsetByFunction.set(name, offset);
      functionNameByRange.set(fn.range, name);
    }
  }
  for (const line of lines) {
    const exported = exportReference(line);
    if (!exported) continue;
    const fn = functionByReference.get(exported.reference);
    const offset = fn ? offsetByLine.get(fn.headerLine) : undefined;
    if (offset !== undefined) {
      offsetByFunction.set(exported.name, offset);
      if (fn && !functionNameByRange.has(fn.range)) {
        functionNameByRange.set(fn.range, exported.name);
      }
    }
  }

  const sortedOffsets = [...lineByOffset.keys()].sort((a, b) => a - b);
  return {
    content: lines.join("\n"),
    offsetForLine: (line) => offsetByLine.get(line),
    lineForOffset: (offset) => {
      const exact = lineByOffset.get(offset);
      if (exact !== undefined) return exact;
      const range = ranges.find(({ start, end }) => offset >= start && offset < end);
      if (!range) return undefined;
      const fn = functions.find((candidate) => candidate.range === range);
      let nearest: number | undefined;
      for (const candidate of sortedOffsets) {
        if (candidate < range.start) continue;
        if (candidate > offset || candidate >= range.end) break;
        nearest = candidate;
      }
      return nearest === undefined ? fn?.headerLine : lineByOffset.get(nearest);
    },
    offsetForFunction: (name) => offsetByFunction.get(name),
    functionForOffset: (offset) => {
      const range = ranges.find(({ start, end }) => offset >= start && offset < end);
      return range ? functionNameByRange.get(range) : undefined;
    },
    rangeForOffset: (offset) => ranges.find(({ start, end }) => offset >= start && offset < end),
  };
}

function textFunctions(
  lines: readonly string[],
  ranges: readonly WasmFunctionRange[]
): TextFunction[] {
  const functions: TextFunction[] = [];
  for (let index = 0; index < lines.length && functions.length < ranges.length; index++) {
    if (!/^  \(func(?:\s|$)/.test(lines[index])) continue;
    const headerLine = index + 1;
    const reference = functionReference(lines[index]);
    const instructionLines: number[] = [];
    for (index++; index < lines.length && lines[index] !== "  )"; index++) {
      const text = lines[index].trim();
      if (!text || text.startsWith("(local") || text.startsWith(";;")) continue;
      instructionLines.push(index + 1);
    }
    functions.push({
      headerLine,
      instructionLines,
      range: ranges[functions.length],
      ...(reference ? { reference } : {}),
    });
  }
  return functions;
}

function functionReference(header: string): string | undefined {
  const symbolic = header.match(/^  \(func\s+(\$"(?:\\.|[^"])*"|\$[^\s(]+)/)?.[1];
  if (symbolic) return symbolic;
  const numeric = header.match(/\(;([0-9]+);\)/)?.[1];
  return numeric;
}

function exportReference(line: string): { name: string; reference: string } | undefined {
  const match = line.match(
    /^  \(export\s+("(?:\\.|[^"])*")\s+\(func\s+(\$"(?:\\.|[^"])*"|\$[^\s)]+|[0-9]+)\)\)/
  );
  if (!match) return undefined;
  return { name: decodeWatString(match[1]), reference: match[2] };
}

function referenceName(reference: string): string | undefined {
  if (!reference.startsWith("$")) return undefined;
  const value = reference.slice(1);
  if (!value.startsWith('"')) return value;
  return decodeWatString(value);
}

function decodeWatString(quoted: string): string {
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return quoted.slice(1, -1);
  }
}

function lineMnemonic(line: string): string | undefined {
  return line.trim().match(/^([^\s(;]+)/)?.[1];
}

function opcodeMnemonic(bytes: Uint8Array, offset: number): string | undefined {
  const opcode = bytes[offset];
  if (opcode === 0xfc) return FC_OPCODES.get(readU32(bytes, offset + 1)?.value ?? -1);
  return CORE_OPCODES.get(opcode);
}

function readU32(bytes: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < bytes.length && offset < start + 5; offset++) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + 1 };
    shift += 7;
  }
  return undefined;
}

const CORE_OPCODES = new Map<number, string>([
  [0x00, "unreachable"],
  [0x01, "nop"],
  [0x02, "block"],
  [0x03, "loop"],
  [0x04, "if"],
  [0x05, "else"],
  [0x0b, "end"],
  [0x0c, "br"],
  [0x0d, "br_if"],
  [0x0e, "br_table"],
  [0x0f, "return"],
  [0x10, "call"],
  [0x11, "call_indirect"],
  [0x12, "return_call"],
  [0x13, "return_call_indirect"],
  [0x1a, "drop"],
  [0x1b, "select"],
  [0x1c, "select"],
  [0x20, "local.get"],
  [0x21, "local.set"],
  [0x22, "local.tee"],
  [0x23, "global.get"],
  [0x24, "global.set"],
  [0x25, "table.get"],
  [0x26, "table.set"],
  [0x28, "i32.load"],
  [0x29, "i64.load"],
  [0x2a, "f32.load"],
  [0x2b, "f64.load"],
  [0x2c, "i32.load8_s"],
  [0x2d, "i32.load8_u"],
  [0x2e, "i32.load16_s"],
  [0x2f, "i32.load16_u"],
  [0x30, "i64.load8_s"],
  [0x31, "i64.load8_u"],
  [0x32, "i64.load16_s"],
  [0x33, "i64.load16_u"],
  [0x34, "i64.load32_s"],
  [0x35, "i64.load32_u"],
  [0x36, "i32.store"],
  [0x37, "i64.store"],
  [0x38, "f32.store"],
  [0x39, "f64.store"],
  [0x3a, "i32.store8"],
  [0x3b, "i32.store16"],
  [0x3c, "i64.store8"],
  [0x3d, "i64.store16"],
  [0x3e, "i64.store32"],
  [0x3f, "memory.size"],
  [0x40, "memory.grow"],
  [0x41, "i32.const"],
  [0x42, "i64.const"],
  [0x43, "f32.const"],
  [0x44, "f64.const"],
  ...numericOpcodes(),
  [0xd0, "ref.null"],
  [0xd1, "ref.is_null"],
  [0xd2, "ref.func"],
  [0xd3, "ref.eq"],
  [0xd4, "ref.as_non_null"],
  [0xd5, "br_on_null"],
  [0xd6, "br_on_non_null"],
]);

function numericOpcodes(): Array<[number, string]> {
  const names = [
    "i32.eqz",
    "i32.eq",
    "i32.ne",
    "i32.lt_s",
    "i32.lt_u",
    "i32.gt_s",
    "i32.gt_u",
    "i32.le_s",
    "i32.le_u",
    "i32.ge_s",
    "i32.ge_u",
    "i64.eqz",
    "i64.eq",
    "i64.ne",
    "i64.lt_s",
    "i64.lt_u",
    "i64.gt_s",
    "i64.gt_u",
    "i64.le_s",
    "i64.le_u",
    "i64.ge_s",
    "i64.ge_u",
    "f32.eq",
    "f32.ne",
    "f32.lt",
    "f32.gt",
    "f32.le",
    "f32.ge",
    "f64.eq",
    "f64.ne",
    "f64.lt",
    "f64.gt",
    "f64.le",
    "f64.ge",
    "i32.clz",
    "i32.ctz",
    "i32.popcnt",
    "i32.add",
    "i32.sub",
    "i32.mul",
    "i32.div_s",
    "i32.div_u",
    "i32.rem_s",
    "i32.rem_u",
    "i32.and",
    "i32.or",
    "i32.xor",
    "i32.shl",
    "i32.shr_s",
    "i32.shr_u",
    "i32.rotl",
    "i32.rotr",
    "i64.clz",
    "i64.ctz",
    "i64.popcnt",
    "i64.add",
    "i64.sub",
    "i64.mul",
    "i64.div_s",
    "i64.div_u",
    "i64.rem_s",
    "i64.rem_u",
    "i64.and",
    "i64.or",
    "i64.xor",
    "i64.shl",
    "i64.shr_s",
    "i64.shr_u",
    "i64.rotl",
    "i64.rotr",
    "f32.abs",
    "f32.neg",
    "f32.ceil",
    "f32.floor",
    "f32.trunc",
    "f32.nearest",
    "f32.sqrt",
    "f32.add",
    "f32.sub",
    "f32.mul",
    "f32.div",
    "f32.min",
    "f32.max",
    "f32.copysign",
    "f64.abs",
    "f64.neg",
    "f64.ceil",
    "f64.floor",
    "f64.trunc",
    "f64.nearest",
    "f64.sqrt",
    "f64.add",
    "f64.sub",
    "f64.mul",
    "f64.div",
    "f64.min",
    "f64.max",
    "f64.copysign",
    "i32.wrap_i64",
    "i32.trunc_f32_s",
    "i32.trunc_f32_u",
    "i32.trunc_f64_s",
    "i32.trunc_f64_u",
    "i64.extend_i32_s",
    "i64.extend_i32_u",
    "i64.trunc_f32_s",
    "i64.trunc_f32_u",
    "i64.trunc_f64_s",
    "i64.trunc_f64_u",
    "f32.convert_i32_s",
    "f32.convert_i32_u",
    "f32.convert_i64_s",
    "f32.convert_i64_u",
    "f32.demote_f64",
    "f64.convert_i32_s",
    "f64.convert_i32_u",
    "f64.convert_i64_s",
    "f64.convert_i64_u",
    "f64.promote_f32",
    "i32.reinterpret_f32",
    "i64.reinterpret_f64",
    "f32.reinterpret_i32",
    "f64.reinterpret_i64",
    "i32.extend8_s",
    "i32.extend16_s",
    "i64.extend8_s",
    "i64.extend16_s",
    "i64.extend32_s",
  ];
  return names.map((name, index) => [0x45 + index, name]);
}

const FC_OPCODES = new Map<number, string>([
  [0, "i32.trunc_sat_f32_s"],
  [1, "i32.trunc_sat_f32_u"],
  [2, "i32.trunc_sat_f64_s"],
  [3, "i32.trunc_sat_f64_u"],
  [4, "i64.trunc_sat_f32_s"],
  [5, "i64.trunc_sat_f32_u"],
  [6, "i64.trunc_sat_f64_s"],
  [7, "i64.trunc_sat_f64_u"],
  [8, "memory.init"],
  [9, "data.drop"],
  [10, "memory.copy"],
  [11, "memory.fill"],
  [12, "table.init"],
  [13, "elem.drop"],
  [14, "table.copy"],
  [15, "table.grow"],
  [16, "table.size"],
  [17, "table.fill"],
]);
