/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// First vertical SourceDebuggerComponent slice: the language-generic REPL
// drives the real embedded LLDB solely through SourceDebuggerSession.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";

let session;
before(async () => {
  session = await ReplSession.attach("factorial");
});
after(async () => {
  await session?.shutdown();
});

test("generic session commands debug C++ through the LLDB component", async () => {
  assert.match(await session.type("components"), /lldb\s+LLDB\s+protocol 0\.1/);
  assert.match(await session.type("modules"), /\[lldb\].*math\.wasm.*debug: dwarf/);

  const breakpoint = await session.type("break compute_factorial");
  assert.match(breakpoint, /Breakpoint lldb:\d+: verified/);

  const stopped = await session.type("continue");
  assert.match(stopped, /compute_factorial/);

  const backtrace = await session.type("bt");
  assert.match(backtrace, /#0 .*compute_factorial.*\[lldb\]/);

  assert.match(await session.type("frame 0"), /#0 .*compute_factorial/);
  assert.match(await session.type("locals"), /\bn\s*=\s*10\b/);
  assert.match(await session.type("p n + 1"), /\b11\b/);
});
