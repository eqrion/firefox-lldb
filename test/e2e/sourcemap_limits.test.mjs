/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "./harness.mjs";

test(
  "excessive source-map expansion degrades symbols without losing the debugger",
  { timeout: 35_000 },
  async (t) => {
    const session = await Session.attach("sourcemap_factorial", {
      setupAttempts: 1,
      transformResponse(path, bytes) {
        if (!path.endsWith(".wasm.map")) return bytes;
        const map = JSON.parse(bytes);
        map.sources = Array.from({ length: 4097 }, (_, i) => `source-${i}.cpp`);
        map.sourcesContent = map.sources.map(() => "");
        return Buffer.from(JSON.stringify(map));
      },
    });
    t.after(() => session.shutdown());
    assert.match(
      readFileSync(session.transcriptPath(), "utf8"),
      /conversion failed.*4096 source files/
    );
    const state = await session.state();
    assert.notEqual(state.reason, "none");
    assert.notEqual(state.reason, "exited");
  }
);
