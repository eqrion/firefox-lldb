/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Source listing and file-backed line-entry tests. Ported from
// test/e2e/test_source_listing.py. Tests verify the wasm and JS frames carry
// valid file/line information; they do not call into the LLDB source manager
// (the embedded wasm LLDB has no filesystem access to the host source tree).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip =
  process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
    ? false
    : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => {
  if (!skip) s = await Session.stoppedAtBreakpoint("factorial");
});
after(async () => {
  await s?.shutdown();
});

test(
  "wasm frame has a valid file and positive line number (DWARF source info)",
  { skip },
  async () => {
    const f0 = await s.topFrame();
    assert.match(f0.function, /compute_factorial/);
    assert.equal(f0.file?.endsWith("math.cpp"), true);
    assert.ok(f0.line > 0, "line number is positive");
  }
);

test(
  "a JS caller frame has a valid file ending in .js with a positive line number",
  { skip },
  async () => {
    const frames = await s.frames();
    const jsFrame = frames.find((f) => f.file?.endsWith(".js"));
    assert.ok(jsFrame, "no JS caller frame found in call stack");
    assert.ok(jsFrame.line > 0, `JS frame line number is positive (got ${jsFrame.line})`);
  }
);
