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

test("an LLDB driver re-arms observers before an intermediate physical resume", async () => {
  const events: string[] = [];
  const driver = fakeComponent("driver", { events });
  const observer = fakeComponent("observer", { events });
  let resolveDriver!: (stop: ComponentStop) => void;
  let observerStop!: Promise<ComponentStop>;
  let resolveObserver!: (stop: ComponentStop) => void;
  let observerCycle = 0;

  observer.startRun = async (_request) => {
    observerCycle++;
    events.push(`arm:observer:${observerCycle}`);
    observerStop = new Promise((resolve) => {
      resolveObserver = resolve;
    });
  };
  observer.waitForStop = async () => observerStop;
  driver.startRun = async () => {
    events.push("arm:driver");
  };
  driver.waitForStop = async () =>
    new Promise((resolve) => {
      resolveDriver = resolve;
    });
  driver.waitForPhysicalResume = async (_runId, afterSequence) => {
    if (afterSequence === 0) return 1;
    if (afterSequence === 1) return 2;
    return new Promise<number | undefined>(() => {});
  };
  driver.releasePhysicalResume = async (runId, sequence) => {
    events.push(`release:driver:${sequence}`);
    if (sequence === 1) {
      resolveObserver({
        runId,
        disposition: "synchronized",
        reason: { kind: "stopped" },
      });
    } else {
      resolveObserver({
        runId,
        disposition: "synchronized",
        reason: { kind: "stopped" },
      });
      resolveDriver({
        runId,
        disposition: "accepted",
        reason: { kind: "step" },
      });
    }
  };

  const session = new SourceDebuggerSession({ components: [driver, observer] });
  const stop = await session.stepOut(undefined);
  assert.equal(stop.reason.kind, "step");
  assert.deepEqual(events.slice(0, 5), [
    "arm:observer:1",
    "arm:driver",
    "release:driver:1",
    "arm:observer:2",
    "release:driver:2",
  ]);
});

test("an observer's internal continue satisfies the intermediate re-arm barrier", async () => {
  const events: string[] = [];
  const driver = fakeComponent("driver");
  const observer = fakeComponent("observer");
  let resolveDriver!: (stop: ComponentStop) => void;
  let resolveObserver!: (stop: ComponentStop) => void;

  observer.startRun = async () => {
    events.push("arm:observer");
  };
  observer.waitForStop = async (_runId) =>
    new Promise((resolve) => {
      resolveObserver = resolve;
    });
  observer.waitForPhysicalResume = async (_runId, afterSequence) => {
    if (afterSequence < 2) {
      const sequence = afterSequence + 1;
      events.push(`ready:observer:${sequence}`);
      return sequence;
    }
    return new Promise<number | undefined>(() => {});
  };
  observer.synchronizeRun = async (runId) => {
    resolveObserver({
      runId,
      disposition: "synchronized",
      reason: { kind: "stopped" },
    });
  };
  driver.startRun = async () => {
    events.push("arm:driver");
  };
  driver.waitForStop = async () =>
    new Promise((resolve) => {
      resolveDriver = resolve;
    });
  driver.waitForPhysicalResume = async (_runId, afterSequence) => {
    if (afterSequence < 2) return afterSequence + 1;
    return new Promise<number | undefined>(() => {});
  };
  driver.releasePhysicalResume = async (runId, sequence) => {
    events.push(`release:driver:${sequence}`);
    if (sequence === 2) {
      resolveDriver({
        runId,
        disposition: "accepted",
        reason: { kind: "step" },
      });
    }
  };

  const session = new SourceDebuggerSession({ components: [driver, observer] });
  const stop = await session.stepOut();
  assert.equal(stop.reason.kind, "step");
  assert.equal(events.filter((event) => event === "arm:observer").length, 1);
  assert.ok(events.indexOf("ready:observer:2") < events.indexOf("release:driver:2"));
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
