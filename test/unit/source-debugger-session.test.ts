/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceDebuggerSession } from "../../src/source-debugger/session.js";
import type { SourceDebuggerComponentInstance } from "../../src/source-debugger/component.js";
import type { RdpWasmSession } from "../../src/rdp/session.js";
import type {
  ComponentRunRequest,
  ComponentStop,
  SourceBreakpoint,
  SourceBreakpointRequest,
} from "../../src/source-debugger/types.js";

function fakeComponent(
  id = "fake",
  options: { events?: string[]; physicalFrameIndex?: number } = {}
): SourceDebuggerComponentInstance {
  const breakpoints = new Map<string, SourceBreakpoint>();
  const runs = new Map<string, Promise<ComponentStop>>();
  return {
    id,
    describe: async () => ({
      protocolVersion: "0.1",
      id,
      name: "Fake debugger",
      capabilities: {
        breakpoints: true,
        conditionalBreakpoints: true,
        evaluate: true,
        stepInto: true,
        stepOver: true,
        stepOut: true,
      },
    }),
    addModules: async (modules) => {
      options.events?.push(`add:${id}:${modules.map(({ id: moduleId }) => moduleId).join(",")}`);
    },
    removeModules: async (moduleIds) => {
      options.events?.push(`remove:${id}:${moduleIds.join(",")}`);
    },
    sources: async () => [],
    state: async (stopId) => ({
      stopId,
      reason: { kind: "breakpoint", threadId: "7" },
    }),
    threads: async () => [{ id: "7", stopped: true }],
    frames: async () => [
      {
        id: "component-frame-0",
        physicalFrameIndex: options.physicalFrameIndex ?? 0,
        inlineFrameIndex: 0,
        functionName: "compute",
        inline: false,
      },
    ],
    scopes: async () => [
      {
        name: "Locals",
        kind: "locals",
        values: [
          { name: "n", value: { name: "n", type: "int", display: "5", hasChildren: false } },
        ],
      },
    ],
    evaluate: async (_stopId, _frameId, expression) => ({
      display: expression === "n + 1" ? "6" : expression,
      hasChildren: false,
    }),
    setBreakpoint: async (request: SourceBreakpointRequest) => {
      const breakpoint: SourceBreakpoint = {
        id: String(breakpoints.size + 1),
        componentId: id,
        verified: true,
        target: request.target,
      };
      breakpoints.set(breakpoint.id, breakpoint);
      return breakpoint;
    },
    removeBreakpoint: async (breakpointId) => {
      breakpoints.delete(breakpointId);
    },
    breakpoints: async () => [...breakpoints.values()],
    startRun: async (request: ComponentRunRequest) => {
      options.events?.push(`start:${id}:${request.role}:${request.action.kind}`);
      runs.set(
        request.runId,
        Promise.resolve({
          runId: request.runId,
          disposition: request.role === "driver" ? "accepted" : "synchronized",
          reason: { kind: request.action.kind === "continue" ? "breakpoint" : "step" },
        })
      );
    },
    waitForStop: async (runId) => {
      options.events?.push(`wait:${id}`);
      const run = runs.get(runId);
      if (!run) throw new Error(`missing ${runId}`);
      return run;
    },
    synchronizeRun: async () => {
      options.events?.push(`sync:${id}`);
    },
    cancelRun: async () => {},
    command: async () => ({ output: "", error: "", status: 0 }),
    dispose: async () => {},
  };
}

test("logical frames are stop-scoped and route inspection to their component", async () => {
  const session = new SourceDebuggerSession({ components: [fakeComponent()] });
  const [frame] = await session.frames();
  assert.equal(frame.functionName, "compute");
  assert.match(frame.id, /^stop-0:7:0:0:fake$/);
  assert.equal((await session.scopes(frame.id))[0].values[0].value.display, "5");
  assert.equal((await session.evaluate(frame.id, "n + 1"))?.display, "6");

  await session.continue();
  await assert.rejects(session.scopes(frame.id), /stale or unknown frame/);
  assert.match((await session.frames())[0].id, /^stop-1:/);
});

test("session breakpoint IDs retain their owning component route", async () => {
  const session = new SourceDebuggerSession({ components: [fakeComponent("owner")] });
  const breakpoint = await session.setBreakpoint({
    target: { kind: "function", name: "compute" },
  });
  assert.equal(breakpoint.id, "owner:1");
  assert.equal((await session.breakpoints())[0].id, "owner:1");
  await session.removeBreakpoint(breakpoint.id);
  assert.deepEqual(await session.breakpoints(), []);
});

test("component IDs must be unique", () => {
  assert.throws(
    () => new SourceDebuggerSession({ components: [fakeComponent(), fakeComponent()] }),
    /must be unique/
  );
});

test("multiple components compose owned frames and arm observers before the step driver", async () => {
  const events: string[] = [];
  const session = new SourceDebuggerSession({
    components: [
      fakeComponent("outer", { events, physicalFrameIndex: 1 }),
      fakeComponent("inner", { events, physicalFrameIndex: 0 }),
    ],
  });

  const frames = await session.frames();
  assert.deepEqual(
    frames.map((frame) => [frame.componentId, frame.physicalFrameIndex]),
    [
      ["inner", 0],
      ["outer", 1],
    ]
  );

  const stop = await session.stepInto(frames[0].id);
  assert.equal(stop.reason.kind, "step");
  assert.deepEqual(events.slice(0, 2), [
    "start:outer:observer:continue",
    "start:inner:driver:step-into",
  ]);
});

test("multi-component breakpoints require and retain an explicit owner", async () => {
  const session = new SourceDebuggerSession({
    components: [fakeComponent("a"), fakeComponent("b")],
  });
  await assert.rejects(
    session.setBreakpoint({ target: { kind: "function", name: "compute" } }),
    /requires an explicit component/
  );
  const breakpoint = await session.setBreakpoint({
    componentId: "b",
    target: { kind: "function", name: "compute" },
  });
  assert.equal(breakpoint.id, "b:1");
});

test("the first component stop synchronizes observers before the session commits", async () => {
  const events: string[] = [];
  const driver = fakeComponent("driver", { events });
  const observer = fakeComponent("observer", { events });
  let resolveObserver!: (stop: ComponentStop) => void;

  driver.waitForStop = async (runId) => ({
    runId,
    disposition: "accepted",
    reason: { kind: "breakpoint" },
  });
  observer.waitForStop = (_runId) =>
    new Promise((resolve) => {
      resolveObserver = resolve;
    });
  observer.synchronizeRun = async (runId) => {
    events.push("sync:observer");
    resolveObserver({
      runId,
      disposition: "synchronized",
      reason: { kind: "interrupt" },
    });
  };

  const session = new SourceDebuggerSession({ components: [driver, observer] });
  const stop = await session.continue("driver");
  assert.equal(stop.reason.kind, "breakpoint");
  assert.ok(events.includes("sync:observer"));
});

test("module refresh assigns one owner and reports additions and removals", async () => {
  const events: string[] = [];
  let urls = ["https://example.test/a.wasm", "https://example.test/b.wasm"];
  const rdp = {
    wasmSources: async () => urls.map((url, index) => ({ actor: String(index), url })),
  } as unknown as RdpWasmSession;
  const session = new SourceDebuggerSession({
    components: [fakeComponent("a", { events }), fakeComponent("b", { events })],
    getRdpSession: () => rdp,
    selectModuleOwner: (module) => (module.url.endsWith("b.wasm") ? "b" : "a"),
  });

  assert.deepEqual(
    (await session.modules()).map(({ id, owner }) => [id, owner]),
    [
      ["https://example.test/a.wasm", "a"],
      ["https://example.test/b.wasm", "b"],
    ]
  );
  assert.ok(events.includes("add:a:https://example.test/a.wasm"));
  assert.ok(events.includes("add:b:https://example.test/b.wasm"));

  urls = ["https://example.test/b.wasm"];
  await session.modules();
  assert.ok(events.includes("remove:a:https://example.test/a.wasm"));
});
