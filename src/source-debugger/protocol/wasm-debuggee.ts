/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SessionStopReason } from "./types.js";

export interface WasmDebuggeeModule {
  id: string;
  url: string;
}

export interface WasmDebuggeeThread {
  id: string;
  stopped: boolean;
}

export interface WasmDebuggeeFrame {
  id: string;
  threadId: string;
  physicalFrameIndex: number;
  moduleId?: string;
  offset?: number;
  functionName?: string;
}

export interface WasmDebuggeeVariable {
  name: string;
  type?: string;
  display: string;
}

export interface WasmDebuggeeStop {
  threadId: string;
  reason: SessionStopReason;
}

export type WasmDebuggeeResumeAction = { kind: "continue" } | { kind: "step"; threadId: string };

/** Transport form of one operation on the resource-oriented Wasm debuggee
 * interface. `type`, `id`, and `method` identify the imported WIT-style
 * resource operation without coupling the component to Firefox actors, TCP,
 * or a debugger engine protocol. Resource values in arguments/results use
 * {@link WasmDebuggeeResourceRef}. */
export type WasmDebuggeeResourceCall =
  | WasmDebuggeeResourceOperation<
      "Debuggee",
      | "allModules"
      | "allInstances"
      | "listThreads"
      | "stoppedThread"
      | "exitFrames"
      | "continue"
      | "singleStep"
      | "interrupt"
    >
  | WasmDebuggeeResourceOperation<"EventFuture", "finish">
  | WasmDebuggeeResourceOperation<
      "Module",
      "uniqueId" | "name" | "bytecode" | "addBreakpoint" | "removeBreakpoint"
    >
  | WasmDebuggeeResourceOperation<"Instance", "getModule" | "uniqueId" | "getMemory" | "getGlobal">
  | WasmDebuggeeResourceOperation<"Memory", "uniqueId" | "sizeBytes" | "getBytes">
  | WasmDebuggeeResourceOperation<"Global", "get" | "uniqueId" | "clone">
  | WasmDebuggeeResourceOperation<
      "Frame",
      "getInstance" | "getFuncIndex" | "getPc" | "getLocals" | "getStack" | "parentFrame"
    >
  | WasmDebuggeeResourceOperation<
      "WasmValue",
      "getType" | "unwrapI32" | "unwrapI64" | "unwrapF32" | "unwrapF64" | "clone"
    >;

interface WasmDebuggeeResourceOperation<Type extends string, Method extends string> {
  type: Type;
  id: number;
  method: Method;
  args: unknown[];
}

export interface WasmDebuggeeResourceRef {
  $res: string;
  id: number;
}

export type WasmDebuggeeEngineResumeAction =
  | { kind: "continue" }
  | { kind: "step"; tid: number; limit: "step" | "next" };

/** A component may arm execution while the session still owns the physical
 * pause lease. The invocation therefore returns the ordinary resource result
 * immediately and reports the proposed resume separately. */
export interface WasmDebuggeeDeferredResume {
  token: string;
  action: WasmDebuggeeEngineResumeAction;
}

export interface WasmDebuggeeInvocationResult {
  value: unknown;
  resume?: WasmDebuggeeDeferredResume;
}

/** Low-level capability imported by a source debugger which understands raw
 * WebAssembly itself. It deliberately exposes Wasm modules, byte offsets,
 * frames, values, breakpoints, and physical run control—not browser actors or
 * a transport implementation. */
export interface WasmDebuggee {
  modules(): Promise<WasmDebuggeeModule[]>;
  moduleBytecode(moduleId: string): Promise<Uint8Array>;
  breakpointOffsets(moduleId: string): Promise<number[]>;

  threads(): Promise<WasmDebuggeeThread[]>;
  frames(threadId: string): Promise<WasmDebuggeeFrame[]>;
  frameVariables(frameId: string): Promise<WasmDebuggeeVariable[]>;

  addBreakpoint(moduleId: string, offset: number): Promise<number>;
  removeBreakpoint(moduleId: string, offset: number): Promise<void>;

  /** Register for the next shared all-stop. Calling this arms only the local
   * observation; resume() is the separate broker-controlled physical lease. */
  waitForStop(): Promise<WasmDebuggeeStop>;
  cancelWaitForStop(): Promise<void>;
  resume(action: WasmDebuggeeResumeAction): Promise<void>;
  interrupt(): Promise<void>;

  /** Complete low-level resource surface used by debugger engines which need
   * the full Wasm machine model (instances, memories, globals, frame chains,
   * and typed values). This is the asynchronous TypeScript projection of the
   * existing gdbstub-component debuggee import; it is not an RSP endpoint. */
  invokeResource(call: WasmDebuggeeResourceCall): Promise<WasmDebuggeeInvocationResult>;

  /** Release a physical resume proposed by invokeResource(). Unknown or stale
   * tokens are ignored so cancellation remains fail-closed with the target paused. */
  grantResume(token: string, action: WasmDebuggeeEngineResumeAction): Promise<void>;

  /** Finish an already-armed local operation at a stop observed by a sibling
   * component, without resuming the physical target. */
  completeWaitAtCurrentStop(completion: {
    reason: "synchronized" | "breakpoint";
    threadId?: string;
  }): Promise<void>;

  dispose(): Promise<void>;
}
