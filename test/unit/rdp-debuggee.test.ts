/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.js";
import type { RdpWasmSession } from "../../src/rdp/session.js";

test("RdpDebuggee.dispose removes its process-exit cleanup listener", () => {
  const before = process.listenerCount("exit");
  const session = new EventEmitter() as RdpWasmSession;
  const debuggee = new RdpDebuggee(session);
  assert.equal(process.listenerCount("exit"), before + 1);

  debuggee.dispose();
  debuggee.dispose();
  assert.equal(process.listenerCount("exit"), before);
});
