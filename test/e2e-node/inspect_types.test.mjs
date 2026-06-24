/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Type-breadth variable inspection. Ported from test/e2e/test_inspect_types.py.
// Breakpoint fires in stop_here() (frame0); the interesting locals are in
// check_types() (frame1). All tests share one stopped session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip =
  process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
    ? false
    : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => {
  if (!skip) s = await Session.stoppedAtBreakpoint("types");
});
after(async () => {
  await s?.shutdown();
});

// All variables live in frame1 (check_types), not frame0 (stop_here).

test("int32_t i = -42 is readable as signed", { skip }, async () => {
  const v = await s.variable(1, "i");
  assert.equal(v.valid, true);
  assert.equal(v.signed, -42);
});

test("uint32_t u = 0xDEADBEEF is readable as unsigned", { skip }, async () => {
  const v = await s.variable(1, "u");
  assert.equal(v.valid, true);
  assert.equal(v.unsigned, 0xdeadbeef);
});

test("float f = 3.14f is readable with correct approximation", { skip }, async () => {
  const v = await s.variable(1, "f");
  assert.equal(v.valid, true);
  assert.ok(Math.abs(parseFloat(v.value) - 3.14) < 0.01, `expected ~3.14, got ${v.value}`);
});

test("double d = 2.718... is readable with correct approximation", { skip }, async () => {
  const v = await s.variable(1, "d");
  assert.equal(v.valid, true);
  assert.ok(
    Math.abs(parseFloat(v.value) - 2.718281828) < 0.000001,
    `expected ~2.718281828, got ${v.value}`
  );
});

test("int32_t* p = &i is a non-null wasm pointer", { skip }, async () => {
  const v = await s.variable(1, "p");
  assert.equal(v.valid, true);
  assert.notEqual(v.unsigned, 0);
});

test("*p == i == -42", { skip }, async () => {
  const deref = await s.variable(1, "*p");
  assert.equal(deref.valid, true);
  assert.equal(deref.signed, -42);
});

test("Point pt = {1.5f, 2.5f}: pt.x and pt.y are readable", { skip }, async () => {
  const x = await s.variable(1, "pt.x");
  const y = await s.variable(1, "pt.y");
  assert.equal(x.valid, true);
  assert.equal(y.valid, true);
  assert.ok(Math.abs(parseFloat(x.value) - 1.5) < 0.01, `pt.x: ${x.value}`);
  assert.ok(Math.abs(parseFloat(y.value) - 2.5) < 0.01, `pt.y: ${y.value}`);
});

test("Packed pk = {3, 5, 255, 0}: bitfield members a==3, b==5", { skip }, async () => {
  const a = await s.variable(1, "pk.a");
  const b = await s.variable(1, "pk.b");
  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.equal(a.unsigned, 3);
  assert.equal(b.unsigned, 5);
});
