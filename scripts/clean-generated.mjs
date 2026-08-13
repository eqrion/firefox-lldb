/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rm } from "node:fs/promises";

const outputs = new Map([
  ["gdbstub", "src/source-debugger/components/lldb/gdbstub/generated"],
  ["sourcemap", "src/sourcemap/generated"],
]);
const name = process.argv[2];
const output = name && outputs.get(name);
if (!output)
  throw new Error(`expected one generated output name: ${[...outputs.keys()].join(", ")}`);
await rm(output, { recursive: true, force: true });
