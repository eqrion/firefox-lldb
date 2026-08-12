/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RdpWasmSession } from "../rdp/session.js";
import type { SourceDebuggerComponentInstance } from "./component.js";
import type {
  BreakpointId,
  CommandResult,
  ComponentId,
  ComponentRunAction,
  LogicalFrame,
  LogicalFrameId,
  ModuleDescriptor,
  RunId,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SessionBreakpointRequest,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "./types.js";

export interface SourceDebuggerSessionOptions {
  components: SourceDebuggerComponentInstance[];
  getRdpSession?: () => RdpWasmSession | undefined;
  selectModuleOwner?: (module: Omit<ModuleDescriptor, "owner">) => ComponentId;
}

interface BreakpointRoute {
  component: SourceDebuggerComponentInstance;
  componentBreakpointId: string;
}

// Language-neutral coordinator for one browser debug target. Components
// project only the physical frames they own. Run control is coordinated with
// an observer-first barrier so isolated debuggers enter each physical run
// before its driver is allowed to resume the target.
export class SourceDebuggerSession {
  readonly #components: SourceDebuggerComponentInstance[];
  readonly #componentById: Map<ComponentId, SourceDebuggerComponentInstance>;
  readonly #getRdpSession: () => RdpWasmSession | undefined;
  readonly #selectModuleOwner: (module: Omit<ModuleDescriptor, "owner">) => ComponentId;
  readonly #frames = new Map<LogicalFrameId, LogicalFrame>();
  readonly #breakpointRoutes = new Map<BreakpointId, BreakpointRoute>();
  #stopNumber = 0;
  #runNumber = 0;
  #stopId: StopId = "stop-0";
  #activeRunId: RunId | undefined;

  constructor(options: SourceDebuggerSessionOptions) {
    if (options.components.length === 0) {
      throw new Error("a SourceDebuggerSession requires at least one component");
    }
    this.#components = [...options.components];
    this.#componentById = new Map(this.#components.map((component) => [component.id, component]));
    if (this.#componentById.size !== this.#components.length) {
      throw new Error("SourceDebuggerComponent ids must be unique within a session");
    }
    this.#getRdpSession = options.getRdpSession ?? (() => undefined);
    this.#selectModuleOwner = options.selectModuleOwner ?? (() => this.#components[0].id);
  }

  currentStopId(): StopId {
    return this.#stopId;
  }

  rdpSession(): RdpWasmSession | undefined {
    return this.#getRdpSession();
  }

  async components() {
    return Promise.all(this.#components.map((component) => component.describe()));
  }

  async modules(): Promise<ModuleDescriptor[]> {
    const sources = await this.#getRdpSession()?.wasmSources();
    return (sources ?? []).map((source) => {
      const module = { id: source.url, url: source.url };
      const owner = this.#selectModuleOwner(module);
      this.#component(owner);
      return { ...module, owner };
    });
  }

  async state(): Promise<SessionState> {
    return this.#components[0].state(this.#stopId);
  }

  async threads(): Promise<SessionThread[]> {
    return this.#components[0].threads(this.#stopId);
  }

  async frames(threadId?: ThreadId): Promise<LogicalFrame[]> {
    const state = await this.state();
    const selectedThread =
      threadId ?? ("threadId" in state.reason ? state.reason.threadId : undefined) ?? "1";
    const projections = await Promise.all(
      this.#components.map(async (component) => ({
        component,
        frames: await component.frames(this.#stopId, selectedThread),
      }))
    );
    this.#frames.clear();
    const frames = projections
      .flatMap(({ component, frames: componentFrames }) =>
        componentFrames.map((frame) => {
          const id = [
            this.#stopId,
            selectedThread,
            frame.physicalFrameIndex,
            frame.inlineFrameIndex,
            component.id,
          ].join(":");
          const logical: LogicalFrame = {
            ...frame,
            id,
            stopId: this.#stopId,
            threadId: selectedThread,
            componentId: component.id,
            componentFrameId: frame.id,
          };
          this.#frames.set(id, logical);
          return logical;
        })
      )
      .sort(
        (a, b) =>
          a.physicalFrameIndex - b.physicalFrameIndex || a.inlineFrameIndex - b.inlineFrameIndex
      );
    return frames;
  }

  async scopes(frameId: LogicalFrameId): Promise<SourceScope[]> {
    const frame = this.#frame(frameId);
    return this.#component(frame.componentId).scopes(this.#stopId, frame.componentFrameId);
  }

  async evaluate(frameId: LogicalFrameId, expression: string): Promise<SourceValue | null> {
    const frame = this.#frame(frameId);
    return this.#component(frame.componentId).evaluate(
      this.#stopId,
      frame.componentFrameId,
      expression
    );
  }

  async setBreakpoint(request: SessionBreakpointRequest): Promise<SourceBreakpoint> {
    const component = request.componentId
      ? this.#component(request.componentId)
      : this.#unambiguousComponent("breakpoint");
    const breakpoint = await component.setBreakpoint(request);
    const id = `${component.id}:${breakpoint.id}`;
    this.#breakpointRoutes.set(id, {
      component,
      componentBreakpointId: breakpoint.id,
    });
    return { ...breakpoint, id };
  }

  async removeBreakpoint(id: BreakpointId): Promise<void> {
    const route = this.#breakpointRoutes.get(id);
    if (!route) throw new Error(`unknown breakpoint ${id}`);
    await route.component.removeBreakpoint(route.componentBreakpointId);
    this.#breakpointRoutes.delete(id);
  }

  async breakpoints(): Promise<SourceBreakpoint[]> {
    const all = await Promise.all(
      this.#components.map(async (component) =>
        (await component.breakpoints()).map((breakpoint) => ({
          ...breakpoint,
          id: `${component.id}:${breakpoint.id}`,
        }))
      )
    );
    return all.flat();
  }

  continue(componentId?: ComponentId) {
    return this.#run({ kind: "continue" }, componentId);
  }

  stepInto(frameId?: LogicalFrameId) {
    const frame = frameId ? this.#frame(frameId) : undefined;
    return this.#run(
      { kind: "step-into", ...(frame ? { frameId: frame.componentFrameId } : {}) },
      frame?.componentId
    );
  }

  stepOver(frameId?: LogicalFrameId) {
    const frame = frameId ? this.#frame(frameId) : undefined;
    return this.#run(
      { kind: "step-over", ...(frame ? { frameId: frame.componentFrameId } : {}) },
      frame?.componentId
    );
  }

  stepOut(frameId?: LogicalFrameId) {
    const frame = frameId ? this.#frame(frameId) : undefined;
    return this.#run(
      { kind: "step-out", ...(frame ? { frameId: frame.componentFrameId } : {}) },
      frame?.componentId
    );
  }

  async command(command: string, componentId?: ComponentId): Promise<CommandResult> {
    const component = componentId
      ? this.#component(componentId)
      : this.#unambiguousComponent("native command");
    if (!component.command) throw new Error(`component ${component.id} has no native command API`);
    const result = await component.command(command);
    if (isRunControlCommand(command)) this.#advanceStop();
    return result;
  }

  async cancelActiveRun(): Promise<void> {
    const runId = this.#activeRunId;
    if (!runId) return;
    await Promise.all(this.#components.map((component) => component.cancelRun(runId)));
  }

  async close(): Promise<void> {
    await Promise.all(this.#components.map((component) => component.dispose()));
    this.#frames.clear();
    this.#breakpointRoutes.clear();
  }

  async #run(
    action: ComponentRunAction,
    driverId?: ComponentId
  ): Promise<SessionState & { output?: string }> {
    const driver = driverId ? this.#component(driverId) : this.#components[0];
    const runId: RunId = `run-${++this.#runNumber}`;
    this.#activeRunId = runId;
    const observers = this.#components.filter((component) => component !== driver);
    try {
      // Observers arm first so no component can miss a fast physical stop when
      // the driver starts its underlying RSP operation.
      await Promise.all(
        observers.map((component) =>
          component.startRun({
            runId,
            role: "observer",
            action: { kind: "continue" },
          })
        )
      );
      await driver.startRun({ runId, role: "driver", action });
      const stops = await Promise.all(
        this.#components.map((component) => component.waitForStop(runId))
      );
      const stop =
        stops.find((candidate) => candidate.disposition === "accepted") ??
        stops[this.#components.indexOf(driver)];
      this.#advanceStop();
      return {
        stopId: this.#stopId,
        reason: stop.reason,
        ...(stop.output ? { output: stop.output } : {}),
      };
    } catch (error) {
      await Promise.allSettled(this.#components.map((component) => component.cancelRun(runId)));
      throw error;
    } finally {
      if (this.#activeRunId === runId) this.#activeRunId = undefined;
    }
  }

  #advanceStop(): void {
    this.#stopId = `stop-${++this.#stopNumber}`;
    this.#frames.clear();
  }

  #frame(id: LogicalFrameId): LogicalFrame {
    const frame = this.#frames.get(id);
    if (!frame || frame.stopId !== this.#stopId) throw new Error(`stale or unknown frame ${id}`);
    return frame;
  }

  #component(id: ComponentId): SourceDebuggerComponentInstance {
    const component = this.#componentById.get(id);
    if (!component) throw new Error(`unknown SourceDebuggerComponent ${id}`);
    return component;
  }

  #unambiguousComponent(operation: string): SourceDebuggerComponentInstance {
    if (this.#components.length !== 1) {
      throw new Error(`${operation} requires an explicit component in a multi-component session`);
    }
    return this.#components[0];
  }
}

function isRunControlCommand(command: string): boolean {
  return /^\s*(?:c|continue|process\s+continue|run|r|thread\s+(?:step|step-in|step-over|step-out|step-inst))\b/i.test(
    command
  );
}
