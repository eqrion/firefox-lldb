/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs, startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/host.ts";
import { IsolatedLldbComponentRuntime } from "../../src/source-debugger/lldb-isolate.ts";
import { createProbeModuleOwnerResolver } from "../../src/source-debugger/ownership.ts";
import { SourceDebuggerSession } from "../../src/source-debugger/session.ts";

test("an isolated LLDB imports its platform RSP connection from the host", async () => {
  const host = new SourceDebuggerSessionHost();
  const runtime = await IsolatedLldbComponentRuntime.create({
    host: host.forComponent("rsp-import"),
    id: "rsp-import",
  });
  const handle = await startPlatformServer(
    parseCliArgs(["--connect", "--port", "0", "--rdp-port", String(await freePort())])
  );
  try {
    const resolveOwner = createProbeModuleOwnerResolver([runtime]);
    assert.equal(
      await resolveOwner({ id: "fixture", url: "https://example.test/fixture.wasm" }),
      "rsp-import"
    );
    assert.deepEqual(
      await runtime.probeModule({
        id: "fixture",
        url: "https://example.test/fixture.wasm",
        debugInfo: ["dwarf"],
      }),
      { supported: true, confidence: 90, reason: "embedded DWARF" }
    );
    await runtime.connectPlatform(handle.port);
    const status = await runtime.command("platform status");
    assert.ok(status.status < 6, status.error || status.output);
    assert.match(status.output, /remote-gdb-server/);
  } finally {
    await handle.shutdown();
    await runtime.close();
    host.close();
  }
});

test("an exited LLDB isolate is quarantined without losing its sibling", async () => {
  const host = new SourceDebuggerSessionHost();
  const runtime = await IsolatedLldbComponentRuntime.create({
    host: host.forComponent("isolated-lldb"),
    id: "isolated-lldb",
  });
  const sibling = await IsolatedLldbComponentRuntime.create({
    host: host.forComponent("surviving-lldb"),
    id: "surviving-lldb",
  });
  const session = new SourceDebuggerSession({
    components: [runtime.component, sibling.component],
    debuggeeHost: host,
  });
  try {
    const resolveOwner = createProbeModuleOwnerResolver([runtime, sibling]);
    await assert.rejects(
      resolveOwner({ id: "fixture", url: "https://example.test/fixture.wasm" }),
      /ambiguous SourceDebuggerComponent claims.*isolated-lldb.*surviving-lldb/
    );
    assert.deepEqual(
      (await session.components()).map(({ id }) => id),
      ["isolated-lldb", "surviving-lldb"]
    );

    await runtime.terminate();
    await assert.rejects(runtime.component.describe(), /SourceDebuggerComponent RPC.*closed/);
    await assert.rejects(runtime.definition.describe(), /SourceDebuggerComponent RPC.*closed/);

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
