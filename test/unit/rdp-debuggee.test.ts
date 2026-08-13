/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { RdpDebuggee } from "../../src/source-debugger/target/firefox/rdp-debuggee.js";
import type { RdpWasmSession } from "../../src/source-debugger/target/firefox/rdp/session.js";

test("RdpDebuggee.dispose removes process and shared-session listeners", () => {
  const before = process.listenerCount("exit");
  const session = new EventEmitter() as RdpWasmSession;
  const debuggee = new RdpDebuggee(session);
  assert.equal(process.listenerCount("exit"), before + 1);
  for (const event of ["stopped", "close", "navigated", "target"]) {
    assert.equal(session.listenerCount(event), 1);
  }

  debuggee.dispose();
  debuggee.dispose();
  assert.equal(process.listenerCount("exit"), before);
  for (const event of ["stopped", "close", "navigated", "target"]) {
    assert.equal(session.listenerCount(event), 0);
  }
});
