/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceDebuggerComponent } from "../../src/source-debugger/protocol/component.js";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/session/host.js";
import { connectSourceDebuggerComponentHost } from "../../src/source-debugger/transport/host-rpc.js";
import {
  serveSourceDebuggerComponentIsolate,
  SourceDebuggerComponentIsolate,
} from "../../src/source-debugger/transport/isolate.js";
import { testSourceDebuggerRun } from "../helpers/source-debugger-run.js";

test("generic isolate transport wires a component and scoped host imports", async () => {
  const sessionHost = new SourceDebuggerSessionHost();
  const binding = sessionHost.forComponent("fake");
  const isolate = new SourceDebuggerComponentIsolate(binding, {
    requestTimeoutMs: 100,
  });
  const importedHost = connectSourceDebuggerComponentHost(isolate.workerPorts.hostPort, {
    requestTimeoutMs: 100,
  });
  const workerEndpoint = serveSourceDebuggerComponentIsolate(
    isolate.workerPorts,
    fakeComponent("fake")
  );

  try {
    await isolate.connect();
    assert.equal(isolate.id, "fake");
    assert.equal((await isolate.component.describe()).name, "Fake fake");

    assert.deepEqual(
      Object.keys(importedHost).sort(),
      ["close", "openWasmDebuggee"],
      "the portable host must not expose debugger-engine transports"
    );
    await assert.rejects(importedHost.openWasmDebuggee(), /no Wasm debuggee target/);
  } finally {
    isolate.close();
    workerEndpoint.close();
    importedHost.close();
    sessionHost.close();
  }
});

test("generic isolate rejects mismatched instance and descriptor identities", async () => {
  const sessionHost = new SourceDebuggerSessionHost();
  const isolate = new SourceDebuggerComponentIsolate(sessionHost.forComponent("instance"));
  const workerEndpoint = serveSourceDebuggerComponentIsolate(
    isolate.workerPorts,
    fakeComponent("instance", "descriptor")
  );
  try {
    await assert.rejects(isolate.connect(), /descriptor id descriptor does not match instance/);
  } finally {
    isolate.close();
    workerEndpoint.close();
    sessionHost.close();
  }
});

function descriptor(id: string) {
  return {
    protocolVersion: "0.2" as const,
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

function fakeComponent(id: string, descriptorId = id): SourceDebuggerComponent {
  return {
    id,
    describe: async () => descriptor(descriptorId),
    addModules: async () => {},
    removeModules: async () => {},
    sources: async () => [],
    sourceContent: async () => null,
    state: async (stopId) => ({ stopId, reason: { kind: "stopped" } }),
    threads: async () => [],
    frames: async () => [],
    scopes: async () => [],
    evaluate: async () => null,
    valueChildren: async () => [],
    setBreakpoint: async (request) => ({
      id: "1",
      componentId: id,
      verified: true,
      target: request.target,
    }),
    removeBreakpoint: async () => {},
    breakpoints: async () => [],
    beginRun: async (request) => testSourceDebuggerRun(request),
    dispose: async () => {},
  };
}
