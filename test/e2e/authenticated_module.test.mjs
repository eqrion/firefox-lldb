/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The browser can load a credentialed module that Node's independent fetch
// cannot. In that case the debugger must read Firefox's source-actor
// ArrayBuffer or it receives no DWARF and cannot resolve this named breakpoint.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("auth_factorial");
});
after(async () => {
  await s?.shutdown();
});

test("browser-owned module bytes recover from an unauthenticated HTTP fallback", async () => {
  assert.ok(s.wasmFetchCount() > 0, "the debugger's unauthenticated HTTP fetch was attempted");
  const frame = await s.topFrame();
  assert.match(frame.function, /compute_factorial/);
  assert.match(frame.file, /math\.cpp$/);
});
