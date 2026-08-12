/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplSession } from "./repl-harness.mjs";

test("component discovery sees source-map metadata without receiving module bytes", async () => {
  const session = await ReplSession.attach("sourcemap_sum");
  try {
    assert.match(await session.type("modules"), /\[lldb\].*math\.wasm.*debug: source-map/);
  } finally {
    await session.shutdown();
  }
});
