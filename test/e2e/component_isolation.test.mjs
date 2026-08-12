/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { IsolatedLldbComponentRuntime } from "../../src/source-debugger/lldb-isolate.ts";

test("an LLDB SourceDebuggerComponent is contained by its outer worker", async () => {
  const runtime = await IsolatedLldbComponentRuntime.create({ id: "isolated-lldb" });
  assert.deepEqual(await runtime.component.describe(), {
    protocolVersion: "0.1",
    id: "isolated-lldb",
    name: "LLDB",
    capabilities: {
      breakpoints: true,
      conditionalBreakpoints: true,
      evaluate: true,
      stepInto: true,
      stepOver: true,
      stepOut: true,
    },
  });

  await runtime.terminate();
  await assert.rejects(runtime.component.describe(), /SourceDebuggerComponent RPC.*closed/);
});
