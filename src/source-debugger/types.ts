/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wire-friendly vocabulary shared by SourceDebuggerComponents, the
// SourceDebuggerSession coordinator, and frontends. These are deliberately
// plain structured-cloneable records: the TypeScript transport can move to
// workers now and to WIT/component-model bindings later without exposing JS
// object identity as part of the protocol.

export type ComponentId = string;
export type ModuleId = string;
export type ThreadId = string;
export type StopId = string;
export type RunId = string;
export type SourceId = string;
export type ComponentFrameId = string;
export type LogicalFrameId = string;
export type BreakpointId = string;
export type ValueId = string;

export interface SourceDebuggerComponentDescriptor {
  protocolVersion: "0.1";
  id: ComponentId;
  name: string;
  capabilities: {
    breakpoints: boolean;
    conditionalBreakpoints: boolean;
    evaluate: boolean;
    stepInto: boolean;
    stepOver: boolean;
    stepOut: boolean;
  };
}

export interface ModuleDescriptor {
  id: ModuleId;
  url: string;
  owner: ComponentId;
  debugInfo?: string[];
}

export interface SourceFile {
  id: SourceId;
  moduleId?: ModuleId;
  url: string;
  language?: string;
}

export interface SourceLocation {
  sourceId: SourceId;
  line: number;
  column?: number;
}

export type BreakpointTarget =
  | { kind: "source"; location: SourceLocation }
  | { kind: "function"; name: string };

export interface SourceBreakpointRequest {
  target: BreakpointTarget;
  condition?: string;
  hitCondition?: string;
}

export interface SessionBreakpointRequest extends SourceBreakpointRequest {
  // Required when more than one component could resolve the requested source
  // or function. A future source registry will infer this for source paths.
  componentId?: ComponentId;
}

export interface SourceBreakpoint {
  id: BreakpointId;
  componentId: ComponentId;
  verified: boolean;
  target: BreakpointTarget;
  message?: string;
}

export type SessionStopReason =
  | { kind: "breakpoint"; threadId?: ThreadId; breakpointId?: string }
  | { kind: "step"; threadId?: ThreadId }
  | { kind: "signal"; threadId?: ThreadId; signal?: string }
  | { kind: "exception"; threadId?: ThreadId }
  | { kind: "interrupt"; threadId?: ThreadId }
  | { kind: "stopped"; threadId?: ThreadId }
  | { kind: "running" }
  | { kind: "exited"; exitCode?: number }
  | { kind: "none" };

export interface SessionState {
  stopId: StopId;
  reason: SessionStopReason;
}

export interface SessionThread {
  id: ThreadId;
  name?: string;
  stopped: boolean;
}

export interface ComponentFrame {
  id: ComponentFrameId;
  // Stop-scoped physical position. This intentionally avoids requiring a
  // stable activation-id extension in the first protocol version.
  physicalFrameIndex: number;
  inlineFrameIndex: number;
  functionName: string;
  location?: SourceLocation;
  pc?: string;
  inline: boolean;
  artificial?: boolean;
}

export interface LogicalFrame extends ComponentFrame {
  id: LogicalFrameId;
  stopId: StopId;
  threadId: ThreadId;
  componentId: ComponentId;
  componentFrameId: ComponentFrameId;
}

export interface SourceValue {
  id?: ValueId;
  name?: string;
  type?: string;
  display: string;
  hasChildren: boolean;
}

export interface SourceProperty {
  name: string;
  value: SourceValue;
}

export interface SourceScope {
  name: string;
  kind: "arguments" | "locals" | "globals" | "registers" | string;
  values: SourceProperty[];
  // Temporary presentation fallback for debugger APIs that do not yet expose
  // structured/lazy values. Frontends should prefer `values` when non-empty.
  presentation?: string;
}

export type ComponentRunAction =
  | { kind: "continue" }
  | { kind: "step-into"; frameId?: ComponentFrameId }
  | { kind: "step-over"; frameId?: ComponentFrameId }
  | { kind: "step-out"; frameId?: ComponentFrameId }
  // Normalize a raw ownership-entry trap before exposing the frame. A
  // component may use its smallest safe execution unit; this is not a
  // frontend-visible instruction-step operation.
  | { kind: "prepare-frame"; frameId: ComponentFrameId };

export interface ComponentRunRequest {
  runId: RunId;
  role: "driver" | "observer";
  action: ComponentRunAction;
}

export interface ComponentStop {
  runId: RunId;
  // `preempted` means an observer recognized a user-visible stop of its own
  // while another component was driving a source thread plan.
  disposition: "accepted" | "synchronized" | "preempted";
  reason: SessionStopReason;
  output?: string;
}

export interface CommandResult {
  output: string;
  error: string;
  status: number;
}
