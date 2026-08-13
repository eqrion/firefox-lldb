/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel } from "node:worker_threads";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponent,
} from "../../src/source-debugger/protocol/component.js";
import {
  connectSourceDebuggerComponent,
  connectSourceDebuggerComponentDefinition,
  SourceDebuggerRpcTransportError,
  serveSourceDebuggerComponent,
  serveSourceDebuggerComponentDefinition,
} from "../../src/source-debugger/transport/rpc.js";
import type { ComponentStop } from "../../src/source-debugger/protocol/types.js";
import { testSourceDebuggerRun } from "../helpers/source-debugger-run.js";
import { SourceDebuggerError } from "../../src/source-debugger/protocol/error.js";

function fakeComponent(overrides: Partial<SourceDebuggerComponent> = {}): SourceDebuggerComponent {
  return {
    id: "fake",
    describe: async () => ({
      protocolVersion: "0.2",
      id: "fake",
      name: "Fake",
      capabilities: {
        breakpoints: true,
        conditionalBreakpoints: false,
        evaluate: true,
        stepInto: true,
        stepOver: true,
        stepOut: true,
      },
    }),
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
      componentId: "fake",
      verified: true,
      target: request.target,
    }),
    removeBreakpoint: async () => {},
    breakpoints: async () => [],
    beginRun: async (request) => testSourceDebuggerRun(request),
    dispose: async () => {},
    ...overrides,
  };
}

test("component definition RPC exposes discovery without an instance", async () => {
  let probed: unknown;
  const definition: SourceDebuggerComponentDefinition = {
    describe: async () => await fakeComponent().describe(),
    probeModule: async (module) => {
      probed = module;
      return { supported: true, confidence: 87, reason: "fixture metadata" };
    },
  };
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponentDefinition(port1, definition);
  const remote = connectSourceDebuggerComponentDefinition(port2, { requestTimeoutMs: 100 });

  assert.equal((await remote.describe()).id, "fake");
  const module = { id: "fixture", url: "fixture.wasm", debugInfo: ["fixture"] };
  assert.deepEqual(await remote.probeModule(module), {
    supported: true,
    confidence: 87,
    reason: "fixture metadata",
  });
  assert.deepEqual(probed, module);
  assert.notEqual(probed, module);

  remote.close();
  endpoint.close();
});

test("component definition RPC bounds a hung discovery call", async () => {
  const definition: SourceDebuggerComponentDefinition = {
    describe: async () => await fakeComponent().describe(),
    probeModule: async () => new Promise(() => {}),
  };
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponentDefinition(port1, definition);
  const remote = connectSourceDebuggerComponentDefinition(port2, { requestTimeoutMs: 10 });

  await assert.rejects(
    remote.probeModule({ id: "fixture", url: "fixture.wasm" }),
    /probeModule timed out after 10ms/
  );
  await assert.rejects(remote.describe(), /RPC is closed/);

  endpoint.close();
});

test("component RPC structured-clones results and preserves optional exports", async () => {
  const scope = {
    name: "Locals",
    kind: "locals",
    values: [{ name: "n", value: { display: "7", hasChildren: false as const } }],
  };
  let disposed = false;
  const component = fakeComponent({
    scopes: async () => [scope],
    dispose: async () => {
      disposed = true;
    },
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  assert.equal(remote.id, "fake");
  assert.equal(remote.command, undefined);
  const scopes = await remote.scopes("stop-1", "frame-0");
  assert.deepEqual(scopes, [scope]);
  assert.notEqual(scopes[0], scope);

  await remote.dispose();
  assert.equal(disposed, true);
  endpoint.close();
});

test("component RPC allows run termination to settle a concurrent stop wait", async () => {
  let settle!: (stop: ComponentStop) => void;
  const component = fakeComponent({
    beginRun: async (request) =>
      testSourceDebuggerRun(request, {
        waitForStop: async () => new Promise((resolve) => (settle = resolve)),
        terminate: async () => {
          settle({
            runId: request.runId,
            disposition: "accepted",
            reason: { kind: "interrupt" },
          });
        },
      }),
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  const run = await remote.beginRun({
    runId: "run-1",
    role: "driver",
    action: { kind: "continue" },
  });
  const stopped = run.waitForStop();
  await run.terminate("cancel");
  assert.equal((await stopped).reason.kind, "interrupt");

  await remote.dispose();
  endpoint.close();
});

test("component RPC preserves remote error details", async () => {
  const component = fakeComponent({
    evaluate: async () => {
      throw new TypeError("expression is not available");
    },
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  await assert.rejects(remote.evaluate("stop-1", "frame-0", "n"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TypeError");
    assert.equal(error.message, "expression is not available");
    return true;
  });

  await remote.dispose();
  endpoint.close();
});

test("component RPC preserves typed source debugger errors", async () => {
  const component = fakeComponent({
    evaluate: async () => {
      throw new SourceDebuggerError("unsupported-operation", "evaluation is disabled", {
        componentId: "fake",
        operation: "evaluate",
      });
    },
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  await assert.rejects(remote.evaluate("stop-1", "frame-0", "n"), (error: unknown) => {
    assert.ok(error instanceof SourceDebuggerError);
    assert.equal(error.code, "unsupported-operation");
    assert.equal(error.componentId, "fake");
    assert.equal(error.operation, "evaluate");
    return true;
  });

  await remote.dispose();
  endpoint.close();
});

test("component RPC rejects a call which exceeds its configured deadline", async () => {
  const component = fakeComponent({
    state: async () => new Promise(() => {}),
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2, { requestTimeoutMs: 50 });

  await assert.rejects(remote.state("stop-1"), (error: unknown) => {
    assert.ok(error instanceof SourceDebuggerRpcTransportError);
    assert.equal(error.failure, "timeout");
    assert.match(error.message, /state timed out after 50ms/);
    return true;
  });
  await assert.rejects(remote.describe(), /RPC is closed/);

  endpoint.close();
});

test("component RPC leaves run waits and native commands outside the bounded-call deadline", async () => {
  const component = fakeComponent({
    beginRun: async (request) =>
      testSourceDebuggerRun(request, { waitForStop: async () => new Promise(() => {}) }),
    command: async () => new Promise(() => {}),
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2, { requestTimeoutMs: 20 });
  const run = await remote.beginRun({
    runId: "run-1",
    role: "driver",
    action: { kind: "continue" },
  });
  const stop = run.waitForStop();
  const command = remote.command!("continue");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    await Promise.race([stop.then(() => "settled"), Promise.resolve("pending")]),
    "pending"
  );
  assert.equal(
    await Promise.race([command.then(() => "settled"), Promise.resolve("pending")]),
    "pending"
  );

  endpoint.close();
  await assert.rejects(stop, /RPC peer closed/);
  await assert.rejects(command, /RPC peer closed/);
});

test("component RPC rejects pending calls when its peer exits", async () => {
  const component = fakeComponent({
    state: async () => new Promise(() => {}),
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  const state = remote.state("stop-1");
  endpoint.close();
  await assert.rejects(state, /RPC peer closed/);

  await remote.dispose().catch(() => {});
});
