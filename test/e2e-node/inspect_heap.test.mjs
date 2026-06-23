/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Heap-allocation inspection tests. Ported from test/e2e/test_inspect_heap.py.
// Stopped at check_heap(Point* pt, int32_t* arr); all tests share one session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip = process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
  ? false
  : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => { if (!skip) s = await Session.stoppedAtBreakpoint("heap"); });
after(async () => { await s?.shutdown(); });

test("heap-allocated Point*: pointer is non-null", { skip }, async () => {
  const pt = await s.variable(0, "pt");
  assert.equal(pt.valid, true);
  assert.notEqual(pt.unsigned, 0);
});

test("pt->x == 1.5 (struct on heap, read through pointer)", { skip }, async () => {
  const x = await s.variable(0, "pt->x");
  assert.equal(x.valid, true);
  assert.ok(Math.abs(parseFloat(x.value) - 1.5) < 0.01, `pt->x: ${x.value}`);
});

test("heap-allocated int32_t[5]: pointer is non-null", { skip }, async () => {
  const arr = await s.variable(0, "arr");
  assert.equal(arr.valid, true);
  assert.notEqual(arr.unsigned, 0);
});

test("arr[0] == 10 (first element of heap array)", { skip }, async () => {
  const elem = await s.variable(0, "arr[0]");
  assert.equal(elem.valid, true);
  assert.equal(elem.signed, 10);
});
