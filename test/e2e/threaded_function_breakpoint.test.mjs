/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A wasm function-name breakpoint must resolve from DWARF only. The raw wasm
// name section includes imported-function indices; LLDB currently interprets
// those as code-function ordinals and can alias a later runtime function to an
// application name (for example emscripten_futex_wake -> matmul_threaded).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

test("pthread function-name breakpoint has only its DWARF location", async () => {
  const s = await Session.attach("threaded");
  try {
    const breakpoint = await s.breakpointByName("matmul_threaded");
    const breakpointId = Session.parseBreakpointId(breakpoint);
    assert.notEqual(breakpointId, null, breakpoint.output);

    const list = await s.command(`breakpoint list ${breakpointId}`);
    assert.match(list.output, /locations = 1\b/, list.output);
    assert.match(list.output, /matmul_threaded/);
    assert.doesNotMatch(list.output, /emscripten_futex_wake/);
  } finally {
    await s.shutdown();
  }
});
