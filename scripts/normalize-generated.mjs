/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const outputs = new Map([
  ["gdbstub", "src/source-debugger/components/lldb/gdbstub/generated"],
  ["sourcemap", "src/sourcemap/generated"],
]);
const name = process.argv[2];
const output = name && outputs.get(name);
if (!output)
  throw new Error(`expected one generated output name: ${[...outputs.keys()].join(", ")}`);

await normalize(output);

async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalize(path);
    } else if ([".js", ".ts"].includes(extname(path))) {
      const source = await readFile(path, "utf8");
      await writeFile(path, source.replace(/[ \t]+$/gm, ""));
    }
  }
}
