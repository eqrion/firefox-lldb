/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LldbWasmDebuggeeAdapter } from "../../src/source-debugger/components/lldb/debuggee-adapter.js";
import type {
  WasmDebuggee,
  WasmDebuggeeDeferredResume,
  WasmDebuggeeResourceCall,
} from "../../src/source-debugger/protocol/wasm-debuggee.js";

test("LLDB adapter keeps RSP resume gating and abort sentinel out of WasmDebuggee", async () => {
  const completions: unknown[] = [];
  const resumes: WasmDebuggeeDeferredResume[] = [];
  const calls: WasmDebuggeeResourceCall[] = [];
  const physicalModule = { $res: "Module", id: 1 };
  const physicalFrame = { $res: "Frame", id: 2 };
  const debuggee = {
    async invokeResource(call: WasmDebuggeeResourceCall) {
      calls.push(call);
      if (call.type === "Debuggee" && call.method === "allModules") {
        return { value: [physicalModule] };
      }
      if (call.type === "Debuggee" && call.method === "continue") {
        return {
          value: { $res: "EventFuture", id: 3 },
          resume: { token: "physical-1", action: { kind: "continue" } },
        };
      }
      if (call.type === "EventFuture") return { value: { tag: "breakpoint" } };
      if (call.type === "Debuggee" && call.method === "stoppedThread") return { value: 7 };
      if (call.type === "Debuggee" && call.method === "exitFrames") {
        return { value: [physicalFrame] };
      }
      throw new Error(`unexpected ${call.type}.${call.method}`);
    },
    async completeWaitAtCurrentStop(completion: unknown) {
      completions.push(completion);
    },
    async dispose() {},
  } as unknown as WasmDebuggee;
  const adapter = new LldbWasmDebuggeeAdapter(debuggee, (resume) => resumes.push(resume), true);

  const modules = (await adapter.dispatch({
    type: "Debuggee",
    id: 0,
    method: "allModules",
    args: [],
  })) as Array<{ $res: string; id: number }>;
  assert.deepEqual(modules[0], physicalModule);
  const abortModule = modules[1];
  assert.equal(
    await adapter.dispatch({
      type: "Module",
      id: abortModule.id,
      method: "name",
      args: [],
    }),
    "__source_debugger_abort__.wasm"
  );

  await adapter.dispatch({
    type: "Debuggee",
    id: 0,
    method: "continue",
    args: [{ tag: "normal" }],
  });
  assert.deepEqual(resumes, [{ token: "physical-1", action: { kind: "continue" } }]);

  await adapter.abortStop();
  assert.deepEqual(completions, [{ reason: "breakpoint" }]);
  await adapter.dispatch({ type: "EventFuture", id: 3, method: "finish", args: [] });
  const frames = (await adapter.dispatch({
    type: "Debuggee",
    id: 0,
    method: "exitFrames",
    args: [7],
  })) as Array<{ $res: string; id: number }>;
  assert.equal(frames.length, 1);
  assert.notDeepEqual(frames[0], physicalFrame);
  assert.deepEqual(
    await adapter.dispatch({
      type: "Frame",
      id: frames[0].id,
      method: "parentFrame",
      args: [],
    }),
    physicalFrame
  );
  assert.equal(
    calls.some((call) => call.type === "Module" && call.id === abortModule.id),
    false,
    "the LLDB-only module escaped into the imported debuggee"
  );
});
