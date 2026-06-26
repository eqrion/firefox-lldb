/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// End-to-end test for Ctrl-C interrupt of a running wasm process.
// Uses a real Firefox + gdbstub + LLDBClient stack so it exercises the full
// triggerInterrupt() → EventFuture.finish → gdbstub stop-reply chain.

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

test("Ctrl-C while running returns the process to the prompt", async () => {
  // No breakpoint — process keeps running in the JS event loop after resuming.
  const typing = s.type("c");
  // Wait for the REPL's "Process running." feedback before sending the interrupt.
  await s.waitFor("Process running.");
  s.interrupt();
  // type() settles when the (lldb) prompt returns. If interrupt fails this hangs.
  const out = await typing;
  assert.match(out, /Process running\./);
});
