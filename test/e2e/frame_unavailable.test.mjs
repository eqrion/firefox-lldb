/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.ts";

test("unavailable frame instance or PC cannot panic or partially publish a real call stack", async (t) => {
  const session = await ReplSession.attach("factorial");
  const dispatch = RdpDebuggee.prototype.dispatch;
  t.after(async () => {
    RdpDebuggee.prototype.dispatch = dispatch;
    await session.shutdown();
  });
  await session.type("breakpoint set -n factorial");
  assert.match(await session.type("continue"), /factorial/);
  let method;
  RdpDebuggee.prototype.dispatch = function (request) {
    if (request.type === "Frame" && request.method === method)
      throw Object.assign(new Error("deliberate unavailable frame"), { payload: "invalid-frame" });
    return dispatch.call(this, request);
  };
  const stack = () => session.type("process plugin packet send qWasmCallStack:1");
  for (const failure of ["getInstance", "getPc"]) {
    method = failure;
    assert.match(await stack(), /response: \s*\n/);
    assert.match(await session.type("process plugin packet send p0"), /response: E/);
    method = undefined;
    assert.match(await stack(), /response: [0-9a-f]{16}/i);
    assert.match(await session.type("process plugin packet send p0"), /response: [0-9a-f]{16}/i);
    assert.match(await session.type("version"), /lldb version/i);
  }
});
