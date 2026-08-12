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
  confidence: number;
  reason?: string;
}

// Placeholder for the typed debuggee capability that the next stage will hand
// to each isolated component. The current LLDB component already reaches that
// capability through its internal RSP/gdbstub connection.
export interface SourceDebuggerComponentHost {}

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
  cancelRun(runId: RunId): Promise<void>;

  // Optional debugger-native escape hatch. It is intentionally not used by
  // generic SourceDebuggerSession inspection/control operations.
  command?(command: string): Promise<CommandResult>;
  dispose(): Promise<void>;
}
