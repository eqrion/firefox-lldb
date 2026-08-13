/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponent,
} from "../../src/source-debugger/protocol/component.js";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/target/host.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentLoader,
} from "../../src/source-debugger/session/loader.js";
import { SourceDebuggerSessionRuntime } from "../../src/source-debugger/session/runtime.js";
import { testSourceDebuggerRun } from "../helpers/source-debugger-run.js";

test("session runtime loads, activates, and closes components in dependency order", async () => {
  const events: string[] = [];
  const host = new SourceDebuggerSessionHost();
  const runtime = await SourceDebuggerSessionRuntime.load({
    host,
    loaders: [fakeLoader("a", events, "ready"), fakeLoader("b", events)],
    eagerComponentIds: ["a", "b"],
  });

  assert.deepEqual(events, ["definition:a", "definition:b", "instantiate:a:a", "instantiate:b:b"]);
  assert.deepEqual(
    (await runtime.session.components()).map(({ id }) => id),
    ["a", "b"]
  );
  assert.deepEqual(await runtime.activate(), { readyMessage: "ready" });
  assert.deepEqual(await runtime.activate(), { readyMessage: "ready" });

  await runtime.close();
  assert.deepEqual(events, [
    "definition:a",
    "definition:b",
    "instantiate:a:a",
    "instantiate:b:b",
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
    eagerComponentIds: ["healthy", "broken"],
  });

  await assert.rejects(runtime.activate(), /activation failed: broken/);
  assert.deepEqual(events, [
    "definition:healthy",
    "definition:broken",
    "instantiate:healthy:healthy",
    "instantiate:broken:broken",
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

test("catalog discovery probes every definition and instantiates only module owners", async () => {
  const events: string[] = [];
  const target = {
    modules: async () => [{ id: "module", url: "module.wasm", debugInfo: ["selected-format"] }],
    close: () => {
      events.push("target:close");
    },
  };
  const runtime = await SourceDebuggerSessionRuntime.load({
    target,
    loaders: [
      discoveryLoader("unsupported", false, events),
      discoveryLoader("selected", true, events),
    ],
  });

  assert.deepEqual(events, [
    "definition:unsupported",
    "definition:selected",
    "probe:unsupported:module",
    "probe:selected:module",
    "instantiate:selected:selected",
  ]);
  assert.deepEqual(
    runtime.components.map(({ id }) => id),
    ["selected"]
  );
  await runtime.close();
  assert.equal(events.at(-1), "target:close");
});

test("a module loaded after startup activates its owner before the next run", async () => {
  const events: string[] = [];
  const sources = [{ url: "component-a.wasm" }];
  const target = {
    modules: async () => sources.map(({ url }) => ({ id: url, url, debugInfo: ["dwarf"] })),
    close: () => {
      events.push("target:close");
    },
  };
  const runtime = await SourceDebuggerSessionRuntime.load({
    target,
    loaders: [
      routedDiscoveryLoader("component-a", events),
      routedDiscoveryLoader("component-b", events),
    ],
  });

  assert.deepEqual(
    runtime.components.map(({ id }) => id),
    ["component-a"]
  );
  await runtime.activate();
  await runtime.session.modules();

  sources.push({ url: "component-b.wasm" });
  const modules = await runtime.session.modules();
  assert.deepEqual(
    modules.map(({ owner }) => owner),
    ["component-a", "component-b"]
  );
  assert.deepEqual(
    runtime.components.map(({ id }) => id),
    ["component-a", "component-b"]
  );
  assert.deepEqual(
    (await runtime.session.components()).map(({ id }) => id),
    ["component-a", "component-b"]
  );
  assert.ok(
    events.indexOf("instantiate:component-b:component-b") < events.indexOf("activate:component-b"),
    "the selected late definition is instantiated before it is attached"
  );

  await runtime.close();
  assert.equal(events.at(-1), "target:close");
});

function fakeLoader(
  id: string,
  events: string[],
  readyMessage?: string,
  failActivation = false
): SourceDebuggerComponentLoader {
  return {
    id,
    async loadDefinition() {
      events.push(`definition:${id}`);
      const definition: SourceDebuggerComponentDefinition = {
        describe: async () => descriptor(id),
        probeModule: async () => ({ supported: true, confidence: 1 }),
      };
      return {
        id,
        definition,
        probeModule: definition.probeModule,
        close: () => {},
      };
    },
    async instantiate() {
      events.push(`instantiate:${id}:${id}`);
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

function discoveryLoader(
  id: string,
  supported: boolean,
  events: string[]
): SourceDebuggerComponentLoader {
  return {
    id,
    async loadDefinition() {
      events.push(`definition:${id}`);
      const definition: SourceDebuggerComponentDefinition = {
        describe: async () => descriptor(id),
        probeModule: async (module) => {
          events.push(`probe:${id}:${module.id}`);
          return {
            supported,
            confidence: supported ? 90 : 0,
            reason: supported ? "selected format" : "different format",
          };
        },
      };
      return {
        id,
        definition,
        probeModule: definition.probeModule,
        close: () => {},
      };
    },
    async instantiate() {
      events.push(`instantiate:${id}:${id}`);
      return fakeLoadedComponent(id, events);
    },
  };
}

function routedDiscoveryLoader(id: string, events: string[]): SourceDebuggerComponentLoader {
  return {
    id,
    async loadDefinition() {
      events.push(`definition:${id}`);
      const definition: SourceDebuggerComponentDefinition = {
        describe: async () => descriptor(id),
        probeModule: async (module) => {
          events.push(`probe:${id}:${module.id}`);
          const supported = module.url.includes(id);
          return { supported, confidence: supported ? 100 : 0 };
        },
      };
      return {
        id,
        definition,
        probeModule: definition.probeModule,
        close: () => {},
      };
    },
    async instantiate() {
      events.push(`instantiate:${id}:${id}`);
      return fakeLoadedComponent(id, events);
    },
  };
}

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

function fakeComponent(id: string, events: string[]): SourceDebuggerComponent {
  return {
    id,
    describe: async () => descriptor(id),
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
    dispose: async () => {
      events.push(`dispose:${id}`);
    },
  };
}
