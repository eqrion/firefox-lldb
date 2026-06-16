/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Derive the byte offsets that Firefox reports as a wasm frame's `where.line`
// for functions in a wasm module.
//
// Firefox/lldb wasm PC offset = <code-section content file offset> + <DWARF
// address>. DWARF addresses are relative to the start of the Code section's
// contents; Firefox reports module-file offsets. This script computes the
// code-section offset from the wasm binary and adds the DWARF line-table
// address, so the two address spaces line up.
//
// Usage:
//   node scripts/wasm-offsets.mjs <module.wasm> [llvm-dwarfdump-path]
//
// Prints every line-table row tagged `prologue_end` (the natural breakpoint
// stop after a function prologue) as: <offset>  line=<n>  (dwarf=<addr>).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const wasmPath = process.argv[2];
const dwarfdump = process.argv[3] ?? "llvm-dwarfdump";
if (!wasmPath) {
  console.error("usage: node scripts/wasm-offsets.mjs <module.wasm> [llvm-dwarfdump]");
  process.exit(1);
}

function codeSectionOffset(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module");
  let o = 8;
  while (o < buf.length) {
    const id = buf[o++];
    let size = 0,
      shift = 0,
      b;
    do {
      b = buf[o++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    if (id === 10) return o; // Code section: contents start here
    o += size;
  }
  throw new Error("no code section");
}

const codeOff = codeSectionOffset(readFileSync(wasmPath));
const out = execFileSync(dwarfdump, ["--debug-line", wasmPath], { encoding: "utf8" });

console.log(`code-section content offset: 0x${codeOff.toString(16)}`);
for (const line of out.split("\n")) {
  const m = line.match(/^0x([0-9a-f]+)\s+(\d+)\s+\d+\s+\d+.*\bprologue_end\b/);
  if (!m) continue;
  const dwarf = parseInt(m[1], 16);
  const off = codeOff + dwarf;
  console.log(
    `  0x${off.toString(16).padStart(4, "0")}  line=${m[2]}  (dwarf=0x${dwarf.toString(16)})`
  );
}
