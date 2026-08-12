/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel } from "node:worker_threads";
import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDebuggerComponentInstance } from "../../src/source-debugger/component.js";
import {
  connectSourceDebuggerComponent,
  SourceDebuggerRpcTransportError,
  serveSourceDebuggerComponent,
} from "../../src/source-debugger/rpc.js";
import type { ComponentStop } from "../../src/source-debugger/types.js";

function fakeComponent(
  overrides: Partial<SourceDebuggerComponentInstance> = {}
): SourceDebuggerComponentInstance {
  return {
    id: "fake",
    describe: async () => ({
      protocolVersion: "0.1",
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
    state: async (stopId) => ({ stopId, reason: { kind: "stopped" } }),
    threads: async () => [],
    frames: async () => [],
    scopes: async () => [],
    evaluate: async () => null,
    setBreakpoint: async (request) => ({
      id: "1",
      componentId: "fake",
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
    ...overrides,
  };
}

test("component RPC structured-clones results and preserves optional exports", async () => {
  const scope = {
    name: "Locals",
    kind: "locals",
    values: [{ name: "n", value: { display: "7", hasChildren: false } }],
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
  assert.equal(remote.abortRun, undefined);
  const scopes = await remote.scopes("stop-1", "frame-0");
  assert.deepEqual(scopes, [scope]);
  assert.notEqual(scopes[0], scope);

  await remote.dispose();
  assert.equal(disposed, true);
  endpoint.close();
});

test("component RPC allows cancelRun to settle a concurrent waitForStop", async () => {
  let settle!: (stop: ComponentStop) => void;
  const component = fakeComponent({
    waitForStop: async () => new Promise((resolve) => (settle = resolve)),
    cancelRun: async (runId) => {
      settle({ runId, disposition: "accepted", reason: { kind: "interrupt" } });
    },
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2);

  const stopped = remote.waitForStop("run-1");
  await remote.cancelRun("run-1");
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
    waitForStop: async () => new Promise(() => {}),
    command: async () => new Promise(() => {}),
  });
  const { port1, port2 } = new MessageChannel();
  const endpoint = serveSourceDebuggerComponent(port1, component);
  const remote = await connectSourceDebuggerComponent(port2, { requestTimeoutMs: 20 });
  const stop = remote.waitForStop("run-1");
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
