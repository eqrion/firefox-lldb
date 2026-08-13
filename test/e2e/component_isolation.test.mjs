/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { FirefoxSourceDebuggerTarget } from "../../src/source-debugger/target/firefox.ts";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/target/host.ts";
import { IsolatedLldbComponentRuntime } from "../../src/source-debugger/components/lldb/isolate.ts";
import {
  LldbSourceDebuggerComponentLoader,
  LldbSourceDebuggerTarget,
} from "../../src/source-debugger/components/lldb/loader.ts";
import { createProbeModuleOwnerResolver } from "../../src/source-debugger/session/ownership.ts";
import { SourceDebuggerSessionRuntime } from "../../src/source-debugger/session/runtime.ts";
import { SourceDebuggerSession } from "../../src/source-debugger/session/session.ts";
import { startStaticServer } from "./harness.mjs";

test("catalog discovery instantiates LLDB but not an unsupported installed ecosystem", async () => {
  const staticServer = await startStaticServer("test/fixtures/simple");
  const route = { id: "lldb", urlSubstring: "*" };
  let unsupportedProbes = 0;
  let unsupportedInstantiations = 0;
  const unsupportedLoader = {
    id: "unsupported",
    async loadDefinition() {
      const definition = {
        describe: async () => ({
          protocolVersion: "0.2",
          id: "unsupported",
          name: "Unsupported test ecosystem",
          capabilities: {
            breakpoints: false,
            conditionalBreakpoints: false,
            evaluate: false,
            stepInto: false,
            stepOver: false,
            stepOut: false,
          },
        }),
        probeModule: async () => {
          unsupportedProbes++;
          return { supported: false, confidence: 0, reason: "different artifact format" };
        },
      };
      return {
        id: "unsupported",
        definition,
        probeModule: definition.probeModule,
        close: () => {},
      };
    },
    async instantiate() {
      unsupportedInstantiations++;
      throw new Error("unsupported ecosystem must not instantiate");
    },
  };
  const args = parseCliArgs([
    "--launch",
    "--headless",
    "--port",
    "0",
    "--rdp-port",
    String(await freePort()),
    "--url",
    `http://127.0.0.1:${staticServer.port}/index.html`,
  ]);
  const target = await FirefoxSourceDebuggerTarget.start({ args });
  const lldbTarget = new LldbSourceDebuggerTarget({
    target,
  });
  const runtime = await SourceDebuggerSessionRuntime.load({
    target,
    loaders: [unsupportedLoader, new LldbSourceDebuggerComponentLoader(lldbTarget, route)],
  });
  try {
    assert.equal(runtime.catalog.entries.length, 2);
    assert.equal(unsupportedProbes, 1);
    assert.equal(unsupportedInstantiations, 0);
    assert.deepEqual(
      runtime.components.map(({ id }) => id),
      ["lldb"]
    );
    const activation = await runtime.activate();
    assert.match(activation.readyMessage, /Process 1 stopped/);
    assert.deepEqual(
      await runtime.components[0].probeModule({
        id: "fixture",
        url: "https://example.test/fixture.wasm",
        debugInfo: ["dwarf"],
      }),
      { supported: true, confidence: 90, reason: "embedded DWARF" }
    );
    assert.deepEqual(
      (await runtime.session.components()).map(({ id }) => id),
      ["lldb"]
    );
    assert.match((await runtime.session.modules())[0].url, /math\.wasm/);
  } finally {
    await runtime.close();
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
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
