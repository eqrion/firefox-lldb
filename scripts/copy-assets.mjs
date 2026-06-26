/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cp, mkdir, readdir } from "node:fs/promises";
import { extname } from "node:path";

await mkdir("dist/gdb/worker", { recursive: true });
const workerFiles = await readdir("src/gdb/worker");
for (const file of workerFiles.filter((f) => extname(f) === ".mjs")) {
  await cp(`src/gdb/worker/${file}`, `dist/gdb/worker/${file}`);
}

await cp("src/gdb/generated", "dist/gdb/generated", { recursive: true });
await cp("src/sourcemap/generated", "dist/sourcemap/generated", { recursive: true });
