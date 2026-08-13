/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  CommandResult,
  ComponentFrame,
  ComponentId,
  ComponentRunRequest,
  ComponentRunTermination,
  ComponentStop,
  ModuleDescriptor,
  PhysicalResumeRequest,
  RunId,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SourceBreakpointRequest,
  SourceDebuggerComponentDescriptor,
  SourceFile,
  SourceProperty,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "./types.js";
import type { WasmDebuggee } from "./wasm-debuggee.js";

export interface ModuleClaim {
  supported: boolean;
  /** Relative ownership confidence from 0 through 100. A unique highest
   * supported claim wins; equal top claims are deliberately ambiguous. */
  confidence: number;
  reason?: string;
}

/** Capabilities imported by a SourceDebuggerComponent. The host exposes the
 * physical Wasm machine, never a debugger-engine protocol such as GDB RSP.
 * An LLDB-backed component is responsible for adapting this resource to the
 * private protocol understood by its embedded LLDB. */
export interface SourceDebuggerComponentHost {
  openWasmDebuggee(): Promise<WasmDebuggee>;
}

export interface SourceDebuggerComponentDefinition {
  describe(): Promise<SourceDebuggerComponentDescriptor>;
  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim>;
}

/** One live, isolated source debugger engine. Construction and target-specific
 * activation are loader concerns, not part of this exported protocol. */
export interface SourceDebuggerComponent {
  readonly id: ComponentId;

  describe(): Promise<SourceDebuggerComponentDescriptor>;
  addModules(modules: ModuleDescriptor[], initialStop: StopId): Promise<void>;
  removeModules(moduleIds: string[]): Promise<void>;
  sources(moduleId?: string): Promise<SourceFile[]>;
  /** Fetch source text lazily. `null` means the component knows the source
   * descriptor but cannot provide its contents. */
  sourceContent(sourceId: string): Promise<string | null>;

  state(stopId: StopId): Promise<SessionState>;
  threads(stopId: StopId): Promise<SessionThread[]>;
  frames(stopId: StopId, threadId: ThreadId): Promise<ComponentFrame[]>;
  scopes(stopId: StopId, frameId: string): Promise<SourceScope[]>;
  evaluate(stopId: StopId, frameId: string, expression: string): Promise<SourceValue | null>;
  /** Expand a stop-scoped value id previously returned by scopes, evaluate,
   * or this method. Components must not accept ids from an older stop. */
  valueChildren(stopId: StopId, valueId: string): Promise<SourceProperty[]>;

  setBreakpoint(request: SourceBreakpointRequest): Promise<SourceBreakpoint>;
  removeBreakpoint(id: string): Promise<void>;
  breakpoints(): Promise<SourceBreakpoint[]>;

  /** Arm one source operation and return its stop-scoped control resource.
   * Resolving this call is the observer barrier: the component must already be
   * ready to observe the next physical stop. */
  beginRun(request: ComponentRunRequest): Promise<SourceDebuggerRun>;

  // Optional debugger-native escape hatch. It is intentionally not used by
  // generic SourceDebuggerSession inspection/control operations.
  command?(command: string): Promise<CommandResult>;
  dispose(): Promise<void>;
}

/** One armed source-level operation. The resource makes the distributed run
 * state machine explicit and prevents run ids or resume sequences from being
 * accidentally mixed across operations. */
export interface SourceDebuggerRun {
  readonly id: RunId;
  readonly role: ComponentRunRequest["role"];

  waitForStop(): Promise<ComponentStop>;

  /** Wait for the debugger to propose its next physical resume. `undefined`
   * means the source operation completed without another resume. Observers
   * expose requests as readiness signals, but the session never grants them. */
  waitForResume(): Promise<PhysicalResumeRequest | undefined>;

  /** Grant a previously returned driver resume token. */
  grantResume(request: PhysicalResumeRequest): Promise<void>;

  /** After an observer reported a synchronized intermediate stop, arm its
   * next continue before the driver is allowed to resume again. */
  rearmObserver(): Promise<void>;

  /** End an in-flight source plan at an already-observed stop, or cancel it
   * after a session failure/user interrupt. */
  terminate(reason: ComponentRunTermination): Promise<void>;

  dispose(): Promise<void>;
}
