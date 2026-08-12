/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import type { LLDBClient } from "lldb-wasm";
import {
  LldbSourceDebuggerComponentInstance,
  type LldbComponentRunControl,
} from "../../src/source-debugger/lldb-component.js";

test("a synchronization race does not hide an observer's own breakpoint", async () => {
  let stoppedBreakpointId = 7;
  const client = {
    sessionCommand: async (command: string) =>
      command.startsWith("breakpoint set")
        ? { output: "Breakpoint 7: 1 location.", error: "", status: 0 }
        : { output: "", error: "", status: 0 },
    sessionState: async () => ({
      reason: "breakpoint",
      thread_id: 1,
      bp_id: stoppedBreakpointId,
    }),
  } as unknown as LLDBClient;
  const runControl = {
    beginRun: async () => {},
    endRun: () => {},
    waitForPhysicalResume: async () => undefined,
    releasePhysicalResume: () => {},
    synchronizeRun: () => {},
    abortRun: () => {},
    isSynchronizing: () => true,
  } satisfies LldbComponentRunControl;
  const component = new LldbSourceDebuggerComponentInstance(client, {
    id: "observer",
    runControl,
  });
  await component.setBreakpoint({ target: { kind: "function", name: "owned" } });

  await component.startRun({
    runId: "owned-stop",
    role: "observer",
    action: { kind: "continue" },
  });
  assert.equal((await component.waitForStop("owned-stop")).disposition, "preempted");

  stoppedBreakpointId = 8;
  await component.startRun({
    runId: "foreign-stop",
    role: "observer",
    action: { kind: "continue" },
  });
  assert.equal((await component.waitForStop("foreign-stop")).disposition, "synchronized");
});

test("an exclusive late component projects owned images after foreign images", async () => {
  const client = {
    sessionFrames: async () => [
      {
        index: 0,
        function: "compute_factorial",
        file: "math.cpp",
        line: 13,
        pc: "0x4000000400000249",
      },
      {
        index: 1,
        function: "??",
        file: "__source_debugger_foreign__.wasm",
        pc: "0x4000000100000015",
      },
    ],
    sessionCommand: async () => ({
      output:
        "[  0] 0x4000000000000000 __source_debugger_foreign__.wasm#1 (0x4000000000000000)\n" +
        "[  4] 0x4000000400000000 math.wasm#5 (0x4000000400000000)\n" +
        "[  5] 0x4000000500000000 __source_debugger_abort__.wasm#6 (0x4000000500000000)\n",
      error: "",
      status: 2,
    }),
  } as unknown as LLDBClient;
  const component = new LldbSourceDebuggerComponentInstance(client, {
    id: "late",
    exclusiveModules: true,
  });
  await component.addModules(
    [{ id: "math", url: "https://example.test/math.wasm", owner: "late" }],
    "stop-1"
  );

  const frames = await component.frames("stop-1", "1");
  assert.deepEqual(
    frames.map(({ functionName, physicalFrameIndex }) => [functionName, physicalFrameIndex]),
    [["compute_factorial", 0]]
  );
});
