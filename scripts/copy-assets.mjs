/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cp } from "node:fs/promises";

await cp("src/gdb/generated", "dist/gdb/generated", { recursive: true });
await cp("src/sourcemap/generated", "dist/sourcemap/generated", { recursive: true });
