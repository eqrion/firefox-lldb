/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "../../src/source-debugger/component.js";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/host.js";
import { connectSourceDebuggerComponentHost } from "../../src/source-debugger/host-rpc.js";
import {
  serveSourceDebuggerComponentIsolate,
  SourceDebuggerComponentIsolate,
} from "../../src/source-debugger/isolate.js";

test("generic isolate transport wires definition, instance, and scoped host imports", async () => {
  const sessionHost = new SourceDebuggerSessionHost();
  const binding = sessionHost.forComponent("fake");
  const isolate = new SourceDebuggerComponentIsolate(binding, { requestTimeoutMs: 100 });
  const importedHost = connectSourceDebuggerComponentHost(isolate.workerPorts.hostPort, {
    requestTimeoutMs: 100,
  });
  const definition: SourceDebuggerComponentDefinition = {
    describe: async () => descriptor("fake"),
    probeModule: async (module) => ({
      supported: module.debugInfo?.includes("fake") ?? false,
      confidence: 95,
      reason: "fake metadata",
    }),
  };
  const workerEndpoint = serveSourceDebuggerComponentIsolate(
    isolate.workerPorts,
    definition,
    fakeComponent("fake")
  );

  try {
    await isolate.connect();
    assert.equal(isolate.id, "fake");
    assert.deepEqual(
      await isolate.probeModule({ id: "module", url: "module.wasm", debugInfo: ["fake"] }),
      { supported: true, confidence: 95, reason: "fake metadata" }
    );
    assert.equal((await isolate.component.describe()).name, "Fake fake");

    const sibling = sessionHost.forComponent("sibling");
    const siblingEndpoint = sibling.registerGdbRspEndpoint(65_534, "process");
    await assert.rejects(importedHost.connectGdbRsp(siblingEndpoint), /unknown process.*rsp-/);
    sibling.discardGdbRspEndpoint(siblingEndpoint);
  } finally {
    isolate.close();
    workerEndpoint.close();
    importedHost.close();
    sessionHost.close();
  }
});

test("generic isolate rejects mismatched definition and instance identities", async () => {
  const sessionHost = new SourceDebuggerSessionHost();
  const isolate = new SourceDebuggerComponentIsolate(sessionHost.forComponent("definition"));
  const workerEndpoint = serveSourceDebuggerComponentIsolate(
    isolate.workerPorts,
    {
      describe: async () => descriptor("definition"),
      probeModule: async () => ({ supported: true, confidence: 1 }),
    },
    fakeComponent("instance")
  );
  try {
    await assert.rejects(isolate.connect(), /definition id definition.*instance id instance/);
  } finally {
    isolate.close();
    workerEndpoint.close();
    sessionHost.close();
  }
});

function descriptor(id: string) {
  return {
    protocolVersion: "0.1" as const,
    id,
    name: `Fake ${id}`,
    capabilities: {
      breakpoints: true,
      conditionalBreakpoints: false,
      evaluate: false,
      stepInto: true,
      stepOver: true,
      stepOut: true,
    },
  };
}

function fakeComponent(id: string): SourceDebuggerComponentInstance {
  return {
    id,
    describe: async () => descriptor(id),
    addModules: async () => {},
    removeModules: async () => {},
    sources: async () => [],
    state: async (stopId) => ({ stopId, reason: { kind: "stopped" } }),
    threads: async () => [],
    frames: async () => [],
    scopes: async () => [],
    evaluate: async () => null,
    setBreakpoint: async (request) => ({
      id: "1",
      componentId: id,
      verified: true,
      target: request.target,
    }),
    removeBreakpoint: async () => {},
    breakpoints: async () => [],
    startRun: async () => {},
    waitForStop: async (runId) => ({
      runId,
      disposition: "accepted",
      reason: { kind: "stopped" },
    }),
    cancelRun: async () => {},
    dispose: async () => {},
  };
}
