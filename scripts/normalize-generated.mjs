/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stable whitespace normalization after jco; no runtime transformations.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: normalize-generated.mjs <generated-js-file>");
const source = readFileSync(file, "utf8");
writeFileSync(file, source.replace(/[ \t]+$/gm, ""));
