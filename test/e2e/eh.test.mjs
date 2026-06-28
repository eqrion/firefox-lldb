/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exception-handling tests (-fwasm-exceptions). Fires run_throw_catch() which
// throws a MyError from deep in the call stack and catches it; the breakpoint
// fires inside handle_error() (the catch handler). All tests share one stopped
// session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("eh");
});
after(async () => {
  await s?.shutdown();
});

test("breakpoint fires inside the catch handler (handle_error frame)", async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /handle_error/);
  assert.equal(f0.file?.endsWith("eh.cpp"), true);
});

test("caught exception object e.code == 42", async () => {
  const code = await s.variable(0, "e.code");
  assert.equal(code.valid, true);
  assert.equal(code.signed, 42);
});

test("caught exception e.msg is a non-null pointer", async () => {
  const msg = await s.variable(0, "e.msg");
  assert.equal(msg.valid, true);
  assert.notEqual(msg.unsigned, 0);
});

test("call stack shows the unwound path: handle_error <- run_throw_catch", async () => {
  const frames = await s.frames();
  const names = frames.map((f) => f.function ?? "");
  assert.ok(
    names.some((n) => /run_throw_catch/.test(n)),
    `expected run_throw_catch in stack; got: ${names.join(", ")}`
  );
});
