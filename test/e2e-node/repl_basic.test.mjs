/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// REPL-path e2e: attach via the `attach` alias path, then drive lldb and `js`
// commands through the real readline REPL, asserting on captured terminal
// output. Requires headless Firefox + built fixtures.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";

let s;
before(async () => {
  s = await ReplSession.attach("factorial");
});
after(async () => {
  await s?.shutdown();
});

test("breakpoint + continue routes through the REPL and prints the stop", async () => {
  const set = await s.type("breakpoint set -n compute_factorial");
  assert.match(set, /Breakpoint 1/);
  const cont = await s.type("process continue");
  assert.match(cont, /compute_factorial/);
});

test("js p evaluates a JS expression in the stopped frame", async () => {
  const out = await s.type("js p 6 * 7");
  assert.match(out, /\b42\b/);
});

test("js bt lists frames of the stopped thread", async () => {
  const out = await s.type("js bt");
  assert.match(out, /#0:/);
});

test("page console output is streamed to the terminal", async () => {
  await s.type("js p (console.log('hello-from-repl'), 1)");
  // The console message arrives asynchronously after the eval result.
  for (let i = 0; i < 20 && !s.output().includes("hello-from-repl"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(s.output(), /hello-from-repl/);
});
