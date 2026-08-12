/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  CommandResult,
  ComponentFrame,
  ComponentId,
  ComponentRunRequest,
  ComponentStop,
  ModuleDescriptor,
  RunId,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SourceBreakpointRequest,
  SourceDebuggerComponentDescriptor,
  SourceFile,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "./types.js";

export interface ModuleClaim {
  supported: boolean;
  /** Relative ownership confidence from 0 through 100. A unique highest
   * supported claim wins; equal top claims are deliberately ambiguous. */
  confidence: number;
  reason?: string;
}

/** One connection to a host-owned GDB Remote Serial Protocol endpoint. This
 * intentionally exposes only an ordered byte stream: TCP, Firefox RDP, and the
 * gdbstub implementation remain outside the source debugger component. */
export interface GdbRspConnection {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface GdbRspEndpoint {
  id: string;
  kind: "platform" | "process";
}

/** Capabilities imported by a SourceDebuggerComponent. The TypeScript
 * prototype uses opaque endpoint ids and byte-stream resources so this shape
 * can become WIT resources without standardizing TCP or Node APIs. */
export interface SourceDebuggerComponentHost {
  connectGdbRsp(endpoint: GdbRspEndpoint): Promise<GdbRspConnection>;
}

export interface SourceDebuggerComponent {
  describe(): Promise<SourceDebuggerComponentDescriptor>;
  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim>;
  instantiate(host: SourceDebuggerComponentHost): Promise<SourceDebuggerComponentInstance>;
}

export interface SourceDebuggerComponentInstance {
  readonly id: ComponentId;

  describe(): Promise<SourceDebuggerComponentDescriptor>;
  addModules(modules: ModuleDescriptor[], initialStop: StopId): Promise<void>;
  removeModules(moduleIds: string[]): Promise<void>;
  sources(moduleId?: string): Promise<SourceFile[]>;

  state(stopId: StopId): Promise<SessionState>;
  threads(stopId: StopId): Promise<SessionThread[]>;
  frames(stopId: StopId, threadId: ThreadId): Promise<ComponentFrame[]>;
  scopes(stopId: StopId, frameId: string): Promise<SourceScope[]>;
  evaluate(stopId: StopId, frameId: string, expression: string): Promise<SourceValue | null>;

  setBreakpoint(request: SourceBreakpointRequest): Promise<SourceBreakpoint>;
  removeBreakpoint(id: string): Promise<void>;
  breakpoints(): Promise<SourceBreakpoint[]>;

  startRun(request: ComponentRunRequest): Promise<void>;
  waitForStop(runId: RunId): Promise<ComponentStop>;
  // LLDB thread plans can resume the physical debuggee more than once before
  // their source-level operation completes. A component which exposes this
  // gate lets the session re-arm every observer before each such resume.
  waitForPhysicalResume?(runId: RunId, afterSequence: number): Promise<number | undefined>;
  releasePhysicalResume?(runId: RunId, sequence: number): Promise<void>;
  synchronizeRun?(runId: RunId): Promise<void>;
  /** Abort this component's active source plan at an already-observed physical
   * stop. Used when a sibling component owns a preempting breakpoint. */
  abortRun?(runId: RunId): Promise<void>;
  cancelRun(runId: RunId): Promise<void>;

  // Optional debugger-native escape hatch. It is intentionally not used by
  // generic SourceDebuggerSession inspection/control operations.
  command?(command: string): Promise<CommandResult>;
  dispose(): Promise<void>;
}
