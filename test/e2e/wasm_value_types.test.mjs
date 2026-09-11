/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.ts";

test(
  "wasm argument types come from the module, not JavaScript number values",
  { timeout: 30_000 },
  async (t) => {
    const s = await ReplSession.attach("types", { fire: "runTypedArguments()" });
    t.after(() => s.shutdown());
    assert.match(
      await s.type("breakpoint set -n typed_arguments --skip-prologue false"),
      /Breakpoint 1/
    );
    assert.match(await s.type("continue"), /typed_arguments/);
    // Exercise the real LLDB transport but assert the bytes this bridge owns.
    // Embedded LLDB's entry-PC DWARF rendering has a separate limitation.
    const local = (index) => s.type(`process plugin packet send qWasmLocal:0;${index}`);
    assert.match(await local(0), /response: 00000040/); // f32 2.0
    assert.match(await local(1), /response: 0000000000000080/); // f64 -0.0
    const dispatch = RdpDebuggee.prototype.dispatch;
    let stackReads = 0;
    RdpDebuggee.prototype.dispatch = function (request) {
      if (request.type === "Frame" && request.method === "getStack") stackReads++;
      return dispatch.call(this, request);
    };
    try {
      assert.match(
        await s.type("process plugin packet send qWasmStackValue:0;0"),
        /response: \s*\n/
      );
      assert.equal(stackReads, 1, "the request exercises unavailable operand-stack reads");
    } finally {
      RdpDebuggee.prototype.dispatch = dispatch;
    }
    const wide = await local(2);
    assert.match(wide, /response: \s*\n/);
    assert.doesNotMatch(wide, /response: 0000000000002000/); // rounded 2^53
    assert.match(
      await local(0),
      /response: 00000040/,
      "unavailable i64 does not poison peer locals"
    );
  }
);
