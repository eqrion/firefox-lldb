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
  dispose(): Promise<void>;
}
