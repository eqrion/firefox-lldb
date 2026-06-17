/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Offline validation tool: build a synthetic wasm+DWARF module for a JS source
// file and write it to disk so you can inspect it before wiring it into the
// live bridge.
//
// Usage:
//   node --import tsx scripts/build-synthetic.mjs <source.js> [out.wasm]
//
// Then validate:
//   llvm-dwarfdump --all out.wasm
//   lldb out.wasm -o "image lookup -a <line>" -o quit

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { buildSyntheticModule } from "../src/gdb/synthetic-module.js";

const srcPath = process.argv[2];
const outPath = process.argv[3] ?? "synthetic-out.wasm";

if (!srcPath) {
  console.error("usage: node --import tsx scripts/build-synthetic.mjs <source.js> [out.wasm]");
  process.exit(1);
}

const text = readFileSync(srcPath, "utf8");
const lineCount = text.split("\n").length;
const name = basename(srcPath);
const compDir = dirname(srcPath);

console.log(`source: ${srcPath} (${lineCount} lines)`);
console.log(`name: ${name}, compDir: ${compDir}`);

const { bytecode, codeOffset } = buildSyntheticModule({ name, compDir, lineCount });

writeFileSync(outPath, bytecode);
console.log(`wrote ${bytecode.length} bytes to ${outPath} (codeOffset=${codeOffset})`);
console.log(`\nValidate with:`);
console.log(`  llvm-dwarfdump --all ${outPath}`);
console.log(`  lldb ${outPath} -o "image lookup -a ${codeOffset + 1}" -o quit`);
console.log(`  # should resolve to ${name}:1`);
