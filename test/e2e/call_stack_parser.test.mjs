/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Parser fixture call-stack and recursion tests. Ported from
// test/e2e-python/test_call_stack.py (parser entry) and test/e2e-python/test_recursion.py.
// All tests share one stopped session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("parser");
});
after(async () => {
  await s?.shutdown();
});

test("stopped in parse_factor at parser.cpp (call stack + DWARF)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /parse_factor/);
  assert.equal(f0.file?.endsWith("parser.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});

test(
  "call stack is >= 3 frames deep (parse_factor / parse_term / parse_expr)",
  async () => {
    const frames = await s.frames();
    assert.ok(frames.length >= 3, `expected >= 3 frames, got ${frames.length}`);
  }
);

test(
  "parent frame names: frame0=parse_factor, frame1=parse_term, frame2=parse_expr",
  async () => {
    const frames = await s.frames();
    assert.match(frames[0].function, /parse_factor/);
    assert.match(frames[1].function, /parse_term/);
    assert.match(frames[2].function, /parse_expr/);
  }
);

test("local 'value' is visible in parse_factor frame", async () => {
  const value = await s.variable(0, "value");
  assert.equal(value.valid, true);
});
