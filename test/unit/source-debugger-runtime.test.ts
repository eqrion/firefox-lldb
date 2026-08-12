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
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentLoader,
} from "../../src/source-debugger/loader.js";
import { SourceDebuggerSessionRuntime } from "../../src/source-debugger/runtime.js";

test("session runtime loads, activates, and closes components in dependency order", async () => {
  const events: string[] = [];
  const host = new SourceDebuggerSessionHost();
  const runtime = await SourceDebuggerSessionRuntime.load({
    host,
    loaders: [fakeLoader("a", events, "ready"), fakeLoader("b", events)],
  });

  assert.deepEqual(events, ["load:a:a", "load:b:b"]);
  assert.deepEqual(
    (await runtime.session.components()).map(({ id }) => id),
    ["a", "b"]
  );
  assert.deepEqual(await runtime.activate(), { readyMessage: "ready" });
  assert.deepEqual(await runtime.activate(), { readyMessage: "ready" });

  await runtime.close();
  assert.deepEqual(events, [
    "load:a:a",
    "load:b:b",
    "activate:a",
    "activate:b",
    "dispose:a",
    "dispose:b",
    "close:b",
    "close:a",
  ]);
  assert.throws(() => host.forComponent("late"), /SourceDebuggerSessionHost is closed/);
});

test("activation failure closes the broker, target activations, and isolates", async () => {
  const events: string[] = [];
  const host = new SourceDebuggerSessionHost();
  const runtime = await SourceDebuggerSessionRuntime.load({
    host,
    loaders: [fakeLoader("healthy", events), fakeLoader("broken", events, undefined, true)],
  });

  await assert.rejects(runtime.activate(), /activation failed: broken/);
  assert.deepEqual(events, [
    "load:healthy:healthy",
    "load:broken:broken",
    "activate:healthy",
    "activate:broken",
    "dispose:healthy",
    "dispose:broken",
    "close:broken",
    "close:healthy",
  ]);
  await runtime.close();
  assert.throws(() => host.forComponent("late"), /SourceDebuggerSessionHost is closed/);
});

function fakeLoader(
  id: string,
  events: string[],
  readyMessage?: string,
  failActivation = false
): SourceDebuggerComponentLoader {
  return {
    id,
    async load(host) {
      events.push(`load:${id}:${host.componentId}`);
      return fakeLoadedComponent(id, events, readyMessage, failActivation);
    },
  };
}

function fakeLoadedComponent(
  id: string,
  events: string[],
  readyMessage?: string,
  failActivation = false
): LoadedSourceDebuggerComponent {
  const definition: SourceDebuggerComponentDefinition = {
    describe: async () => descriptor(id),
    probeModule: async () => ({ supported: true, confidence: 1 }),
  };
  return {
    id,
    definition,
    component: fakeComponent(id, events),
    probeModule: definition.probeModule,
    async activate() {
      events.push(`activate:${id}`);
      if (failActivation) throw new Error(`activation failed: ${id}`);
      return readyMessage === undefined ? {} : { readyMessage };
    },
    close() {
      events.push(`close:${id}`);
    },
  };
}

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

function fakeComponent(id: string, events: string[]): SourceDebuggerComponentInstance {
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
    dispose: async () => {
      events.push(`dispose:${id}`);
    },
  };
}
