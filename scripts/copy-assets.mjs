/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cp, mkdir, readdir } from "node:fs/promises";
import { extname } from "node:path";

const GDBSTUB = "source-debugger/components/lldb/gdbstub";

await mkdir(`dist/${GDBSTUB}/worker`, { recursive: true });
const workerFiles = await readdir(`src/${GDBSTUB}/worker`);
for (const file of workerFiles.filter((f) => extname(f) === ".mjs")) {
  await cp(`src/${GDBSTUB}/worker/${file}`, `dist/${GDBSTUB}/worker/${file}`);
}

await cp(`src/${GDBSTUB}/generated`, `dist/${GDBSTUB}/generated`, { recursive: true });
await cp("src/sourcemap/generated", "dist/sourcemap/generated", { recursive: true });
