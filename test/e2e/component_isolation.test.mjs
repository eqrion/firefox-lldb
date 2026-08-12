/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { IsolatedLldbComponentRuntime } from "../../src/source-debugger/lldb-isolate.ts";
import { SourceDebuggerSession } from "../../src/source-debugger/session.ts";

test("an exited LLDB isolate is quarantined without losing its sibling", async () => {
  const runtime = await IsolatedLldbComponentRuntime.create({ id: "isolated-lldb" });
  const sibling = await IsolatedLldbComponentRuntime.create({ id: "surviving-lldb" });
  const session = new SourceDebuggerSession({
    components: [runtime.component, sibling.component],
  });
  try {
    assert.deepEqual(
      (await session.components()).map(({ id }) => id),
      ["isolated-lldb", "surviving-lldb"]
    );

    await runtime.terminate();
    await assert.rejects(runtime.component.describe(), /SourceDebuggerComponent RPC.*closed/);

    const statuses = await session.componentStatuses();
    assert.equal(statuses[0].status, "quarantined");
    assert.match(statuses[0].message, /SourceDebuggerComponent RPC.*closed/);
    assert.equal(statuses[1].status, "ready");
    assert.deepEqual(
      (await session.components()).map(({ id }) => id),
      ["surviving-lldb"]
    );
  } finally {
    await session.close();
    await runtime.close();
    await sibling.close();
  }
});
