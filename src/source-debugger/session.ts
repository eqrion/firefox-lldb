/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RdpWasmSession } from "../rdp/session.js";
import { noopLogger, type Logger } from "../logging.js";
import type { SourceDebuggerComponentInstance } from "./component.js";
import type { SourceDebuggerSessionHost } from "./host.js";
import type { ModuleOwnerResolver } from "./ownership.js";
import { isSourceDebuggerRpcTransportError } from "./rpc.js";
import type {
  BreakpointId,
  CommandResult,
  ComponentId,
  ComponentRunAction,
  ComponentStop,
  LogicalFrame,
  LogicalFrameId,
  ModuleDescriptor,
  RunId,
  SessionComponentStatus,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SessionBreakpointRequest,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
  SourceDebuggerComponentDescriptor,
} from "./types.js";

export interface SourceDebuggerSessionOptions {
  components: SourceDebuggerComponentInstance[];
  getRdpSession?: () => RdpWasmSession | undefined;
  resolveModuleOwner?: ModuleOwnerResolver;
  /** Lazily create and attach an installed component selected for a module
   * which appeared after initial discovery. Called only while stopped. */
  ensureComponent?: (componentId: ComponentId) => Promise<SourceDebuggerComponentInstance>;
  /** Imported debuggee capabilities owned and revoked with this session. */
  debuggeeHost?: SourceDebuggerSessionHost;
  logger?: Logger;
}

interface BreakpointRoute {
  component: SourceDebuggerComponentInstance;
  componentBreakpointId: string;
}

interface ComponentRunWait {
  component: SourceDebuggerComponentInstance;
  stop: Promise<{ component: SourceDebuggerComponentInstance; stop: ComponentStop }>;
  resumeSequence: number;
}

const MAX_TRANSPARENT_STEP_IN_STOPS = 32;

// Language-neutral coordinator for one browser debug target. Components
// project only the physical frames they own. Run control is coordinated with
// an observer-first barrier so isolated debuggers enter each physical run
// before its driver is allowed to resume the target.
export class SourceDebuggerSession {
  readonly #components: SourceDebuggerComponentInstance[];
  readonly #componentById: Map<ComponentId, SourceDebuggerComponentInstance>;
  readonly #getRdpSession: () => RdpWasmSession | undefined;
  readonly #resolveModuleOwner: ModuleOwnerResolver;
  readonly #ensureComponent:
    | ((componentId: ComponentId) => Promise<SourceDebuggerComponentInstance>)
    | undefined;
  readonly #debuggeeHost: SourceDebuggerSessionHost | undefined;
  readonly #logger: Logger;
  readonly #frames = new Map<LogicalFrameId, LogicalFrame>();
  readonly #breakpointRoutes = new Map<BreakpointId, BreakpointRoute>();
  readonly #componentDescriptors = new Map<ComponentId, SourceDebuggerComponentDescriptor>();
  readonly #quarantined = new Map<ComponentId, Error>();
  #moduleById = new Map<string, ModuleDescriptor>();
  #moduleSync: Promise<ModuleDescriptor[]> | undefined;
  #stopNumber = 0;
  #runNumber = 0;
  #stopId: StopId = "stop-0";
  #activeRunId: RunId | undefined;
  #stateComponentId: ComponentId;

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
    this.#resolveModuleOwner = options.resolveModuleOwner ?? (async () => this.#components[0].id);
    this.#ensureComponent = options.ensureComponent;
    this.#debuggeeHost = options.debuggeeHost;
    this.#logger = options.logger ?? noopLogger;
    this.#stateComponentId = this.#components[0].id;
  }

  currentStopId(): StopId {
    return this.#stopId;
  }

  rdpSession(): RdpWasmSession | undefined {
    return this.#getRdpSession();
  }

  async components(): Promise<SourceDebuggerComponentDescriptor[]> {
    return (await this.componentStatuses()).flatMap((component) =>
      component.status === "ready" ? [component.descriptor] : []
    );
  }

  async componentStatuses(): Promise<SessionComponentStatus[]> {
    return Promise.all(
      this.#components.map(async (component): Promise<SessionComponentStatus> => {
        const failure = this.#quarantined.get(component.id);
        if (failure) {
          const descriptor = this.#componentDescriptors.get(component.id);
          return {
            id: component.id,
            status: "quarantined",
            message: failure.message,
            ...(descriptor ? { descriptor } : {}),
          };
        }
        try {
          const descriptor = await this.#invoke(component, "describe", () => component.describe());
          this.#componentDescriptors.set(component.id, descriptor);
          return { id: component.id, status: "ready", descriptor };
        } catch (error) {
          if (!(error instanceof ComponentUnavailableError)) throw error;
          return {
            id: component.id,
            status: "quarantined",
            message: error.message,
            ...(this.#componentDescriptors.has(component.id)
              ? { descriptor: this.#componentDescriptors.get(component.id) }
              : {}),
          };
        }
      })
    );
  }

  async modules(): Promise<ModuleDescriptor[]> {
    return (this.#moduleSync ??= this.#refreshModules().finally(() => {
      this.#moduleSync = undefined;
    }));
  }

  async state(): Promise<SessionState> {
    return this.#firstAvailable(
      "state",
      (component) => component.state(this.#stopId),
      this.#stateComponentId
    );
  }

  async threads(): Promise<SessionThread[]> {
    return this.#firstAvailable(
      "threads",
      (component) => component.threads(this.#stopId),
      this.#stateComponentId
    );
  }

  async frames(threadId?: ThreadId): Promise<LogicalFrame[]> {
    await this.modules();
    const state = await this.state();
    const selectedThread =
      threadId ?? ("threadId" in state.reason ? state.reason.threadId : undefined) ?? "1";
    this.#frames.clear();
    const projections = await this.#collectAvailable("frames", async (component) => ({
      component,
      frames: await component.frames(this.#stopId, selectedThread),
    }));
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
    const component = this.#component(frame.componentId);
    return this.#invoke(component, "scopes", () =>
      component.scopes(this.#stopId, frame.componentFrameId)
    );
  }

  async evaluate(frameId: LogicalFrameId, expression: string): Promise<SourceValue | null> {
    const frame = this.#frame(frameId);
    const component = this.#component(frame.componentId);
    return this.#invoke(component, "evaluate", () =>
      component.evaluate(this.#stopId, frame.componentFrameId, expression)
    );
  }

  async setBreakpoint(request: SessionBreakpointRequest): Promise<SourceBreakpoint> {
    await this.modules();
    const component = request.componentId
      ? this.#component(request.componentId)
      : this.#unambiguousComponent("breakpoint");
    const breakpoint = await this.#invoke(component, "setBreakpoint", () =>
      component.setBreakpoint(request)
    );
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
    await this.#invoke(route.component, "removeBreakpoint", () =>
      route.component.removeBreakpoint(route.componentBreakpointId)
    );
    this.#breakpointRoutes.delete(id);
  }

  async breakpoints(): Promise<SourceBreakpoint[]> {
    const all = await this.#collectAvailable("breakpoints", async (component) =>
      (await component.breakpoints()).map((breakpoint) => ({
        ...breakpoint,
        id: `${component.id}:${breakpoint.id}`,
      }))
    );
    return all.flat();
  }

  continue(componentId?: ComponentId) {
    return this.#run({ kind: "continue" }, componentId);
  }

  async stepInto(frameId?: LogicalFrameId) {
    const selected = frameId ? this.#frame(frameId) : undefined;
    if (!selected) return this.#run({ kind: "step-into" });

    let before = await this.frames(selected.threadId);
    const selectedIndex = before.findIndex(({ id }) => id === selected.id);
    if (selectedIndex < 0) throw new Error(`stale or unknown frame ${selected.id}`);
    let frame = before[selectedIndex];
    let adoptingForeignEntry = false;

    for (let transition = 0; transition <= MAX_TRANSPARENT_STEP_IN_STOPS; transition++) {
      const stop = await this.#run(
        {
          kind: adoptingForeignEntry ? "prepare-frame" : "step-into",
          frameId: frame.componentFrameId,
        },
        frame.componentId
      );
      if (stop.reason.kind !== "step") return stop;

      const after = await this.frames(selected.threadId);
      if (adoptingForeignEntry) return stop;
      if (!sameSourceStack(before, after)) {
        const top = after[0];
        if (top && top.componentId !== frame.componentId) {
          const destination = this.#component(top.componentId);
          const destinationState = await this.#invoke(destination, "state", () =>
            destination.state(this.#stopId)
          );
          if (isForeignEntryTrap(destinationState.reason)) {
            // An instruction-level step across opaque JavaScript stops at the
            // destination Wasm function's raw entry PC. Give the destination
            // owner one source step to skip its prologue and materialize
            // parameters. A real destination breakpoint is deliberately not
            // adopted, so user-visible stops always preempt the thread plan.
            frame = top;
            adoptingForeignEntry = true;
            continue;
          }
        }
        return stop;
      }
      if (transition === MAX_TRANSPARENT_STEP_IN_STOPS) {
        throw new Error(
          `step-in crossed more than ${MAX_TRANSPARENT_STEP_IN_STOPS} source-transparent stops`
        );
      }

      // LLDB can complete a source thread plan on an opaque foreign-language
      // transition even though the composed source stack has not changed. Run
      // the selected component's next source step from its newly-projected
      // physical frame. A newly-entered component, recursion, or source-line
      // change alters the semantic stack and is returned to the frontend.
      before = after;
      frame = after[selectedIndex];
    }

    throw new Error("unreachable step-in transition state");
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
    const result = await this.#invoke(component, "command", () => component.command!(command));
    if (isRunControlCommand(command)) {
      this.#stateComponentId = component.id;
      this.#advanceStop();
    }
    return result;
  }

  async cancelActiveRun(): Promise<void> {
    const runId = this.#activeRunId;
    if (!runId) return;
    await Promise.allSettled(
      this.#activeComponents().map((component) =>
        this.#invoke(component, "cancelRun", () => component.cancelRun(runId))
      )
    );
  }

  async close(): Promise<void> {
    try {
      await Promise.allSettled(this.#components.map((component) => component.dispose()));
    } finally {
      this.#debuggeeHost?.close();
    }
    this.#frames.clear();
    this.#breakpointRoutes.clear();
    this.#componentDescriptors.clear();
    this.#moduleById.clear();
    this.#quarantined.clear();
  }

  async #refreshModules(): Promise<ModuleDescriptor[]> {
    const rdp = this.#getRdpSession();
    const sources = await rdp?.wasmSources();
    const next = new Map<string, ModuleDescriptor>();
    for (const source of sources ?? []) {
      const existing = next.get(source.url) ?? this.#moduleById.get(source.url);
      if (existing) {
        next.set(existing.id, existing);
        continue;
      }
      if (this.#activeRunId) {
        throw new Error(
          `cannot assign newly loaded Wasm module ${source.url} during active run ${this.#activeRunId}`
        );
      }

      const debugInfo = await rdp?.wasmModuleDebugInfo?.(source.url);
      const module = {
        id: source.url,
        url: source.url,
        ...(debugInfo ? { debugInfo } : {}),
      };
      // Ownership is sticky for the lifetime of a loaded module. Re-running
      // discovery on every refresh could silently move it between debuggers if
      // a component is installed, removed, or changes its probe result.
      const owner = await this.#resolveModuleOwner(module);
      if (!this.#componentById.has(owner)) {
        if (!this.#ensureComponent) {
          throw new Error(`unknown SourceDebuggerComponent ${owner}`);
        }
        const component = await this.#ensureComponent(owner);
        if (component.id !== owner) {
          throw new Error(
            `requested SourceDebuggerComponent ${owner} but activation returned ${component.id}`
          );
        }
        if (!this.#componentById.has(owner)) {
          this.#components.push(component);
          this.#componentById.set(owner, component);
        }
      }
      this.#knownComponent(owner);
      next.set(module.id, { ...module, owner });
    }

    for (const component of this.#activeComponents()) {
      const removed = [...this.#moduleById.values()]
        .filter(
          (module) => module.owner === component.id && next.get(module.id)?.owner !== component.id
        )
        .map(({ id }) => id);
      if (removed.length) {
        try {
          await this.#invoke(component, "removeModules", () => component.removeModules(removed));
        } catch (error) {
          if (error instanceof ComponentUnavailableError) continue;
          throw error;
        }
      }

      const added = [...next.values()].filter(
        (module) =>
          module.owner === component.id && this.#moduleById.get(module.id)?.owner !== component.id
      );
      if (added.length) {
        try {
          await this.#invoke(component, "addModules", () =>
            component.addModules(added, this.#stopId)
          );
        } catch (error) {
          if (error instanceof ComponentUnavailableError) continue;
          throw error;
        }
      }
    }

    this.#moduleById = next;
    return [...next.values()];
  }

  async #run(
    action: ComponentRunAction,
    driverId?: ComponentId
  ): Promise<SessionState & { output?: string }> {
    // A late component attaches to the target at the current physical stop.
    // Never let a new run begin until an in-progress stopped module refresh,
    // activation, and addModules() handoff finish.
    await this.#moduleSync;
    const active = this.#activeComponents();
    if (active.length === 0) throw new Error("all SourceDebuggerComponents are quarantined");
    const driver = driverId ? this.#component(driverId) : active[0];
    const runId: RunId = `run-${++this.#runNumber}`;
    this.#activeRunId = runId;
    let observers = active.filter((component) => component !== driver);
    try {
      // Observers arm first so no component can miss a fast physical stop when
      // the driver starts its underlying RSP operation.
      const armed = await Promise.allSettled(
        observers.map((component) =>
          this.#invoke(component, "startRun", () =>
            component.startRun({
              runId,
              role: "observer",
              action: { kind: "continue" },
            })
          )
        )
      );
      const survivingObservers: SourceDebuggerComponentInstance[] = [];
      for (let index = 0; index < armed.length; index++) {
        const result = armed[index];
        if (result.status === "fulfilled") survivingObservers.push(observers[index]);
        else if (!(result.reason instanceof ComponentUnavailableError)) throw result.reason;
      }
      observers = survivingObservers;
      this.#logger.debug(`[session] ${runId} observers armed; starting ${driver.id}`);
      await this.#invoke(driver, "startRun", () =>
        driver.startRun({ runId, role: "driver", action })
      );
      this.#logger.debug(`[session] ${runId} driver armed`);
      const driverWait = this.#invoke(driver, "waitForStop", () => driver.waitForStop(runId)).then(
        (stop) => ({ component: driver, stop })
      );
      const observerWaits: ComponentRunWait[] = await Promise.all(
        observers.map(async (component) => ({
          component,
          stop: this.#invoke(component, "waitForStop", () => component.waitForStop(runId)).then(
            (stop) => ({ component, stop })
          ),
          resumeSequence:
            (await this.#invoke(component, "waitForPhysicalResume", () =>
              component.waitForPhysicalResume?.(runId, 0)
            )) ?? 0,
        }))
      );
      this.#logger.debug(`[session] ${runId} observer resume sequences captured`);
      const firstResume = await this.#invoke(driver, "waitForPhysicalResume", () =>
        driver.waitForPhysicalResume?.(runId, 0)
      );
      this.#logger.debug(`[session] ${runId} first driver resume ${String(firstResume)}`);
      if (
        firstResume !== undefined &&
        driver.waitForPhysicalResume &&
        driver.releasePhysicalResume
      ) {
        await this.#invoke(driver, "releasePhysicalResume", () =>
          driver.releasePhysicalResume!(runId, firstResume)
        );
        let resumeSequence = firstResume;
        for (;;) {
          this.#logger.debug(`[session] ${runId} waiting after driver resume ${resumeSequence}`);
          const progress = await Promise.race([
            driverWait.then((result) => ({ kind: "complete" as const, result })),
            this.#invoke(driver, "waitForPhysicalResume", () =>
              driver.waitForPhysicalResume!(runId, resumeSequence)
            ).then((sequence) => ({ kind: "resume" as const, sequence })),
            this.#waitForObserverPreemption(observerWaits).then((result) => ({
              kind: "preempted" as const,
              result,
            })),
          ]);
          if (progress.kind === "preempted") {
            this.#logger.debug(`[session] ${runId} preempted by ${progress.result.component.id}`);
            return this.#commitPreemptedStop(progress.result, driverWait, observerWaits, runId);
          }
          if (progress.kind === "complete" || progress.sequence === undefined) {
            const result = progress.kind === "complete" ? progress.result : await driverWait;
            await Promise.all(
              observers.map((component) =>
                this.#invoke(component, "synchronizeRun", () => component.synchronizeRun?.(runId))
              )
            );
            return this.#commitRunStop([
              result,
              ...(await Promise.all(observerWaits.map(({ stop }) => stop))),
            ]);
          }

          // The driver's source-level operation is still active, but LLDB has
          // reached an internal physical stop and wants to resume again. An
          // observer either asks to continue too (which means it has already
          // armed its next local stop wait) or completes at this stop and must
          // be started again. In both cases, hold the driver's physical lease
          // until every observer is ready for the next stop.
          const prepared = await Promise.all(
            observerWaits.map((observer) => this.#prepareObserverResume(observer, runId))
          );
          const preempted = prepared.find((result) => result !== undefined);
          if (preempted) {
            return this.#commitPreemptedStop(preempted, driverWait, observerWaits, runId);
          }
          resumeSequence = progress.sequence;
          await this.#invoke(driver, "releasePhysicalResume", () =>
            driver.releasePhysicalResume!(runId, resumeSequence)
          );
        }
      }

      const waits = [driverWait, ...observerWaits.map(({ stop }) => stop)];
      const first = await Promise.race(waits);
      await Promise.all(
        this.#activeComponents()
          .filter((component) => component !== first.component)
          .map((component) =>
            this.#invoke(component, "synchronizeRun", () => component.synchronizeRun?.(runId))
          )
      );
      return this.#commitRunStop(await Promise.all(waits));
    } catch (error) {
      await Promise.allSettled(
        this.#activeComponents().map((component) =>
          this.#invoke(component, "cancelRun", () => component.cancelRun(runId))
        )
      );
      if (error instanceof ComponentUnavailableError) this.#advanceStop();
      throw error;
    } finally {
      if (this.#activeRunId === runId) this.#activeRunId = undefined;
    }
  }

  async #prepareObserverResume(
    observer: ComponentRunWait,
    runId: RunId
  ): Promise<{ component: SourceDebuggerComponentInstance; stop: ComponentStop } | undefined> {
    let completed: { component: SourceDebuggerComponentInstance; stop: ComponentStop } | undefined;
    if (observer.component.waitForPhysicalResume) {
      const progress = await Promise.race([
        observer.stop.then((result) => ({ kind: "complete" as const, result })),
        this.#invoke(observer.component, "waitForPhysicalResume", () =>
          observer.component.waitForPhysicalResume!(runId, observer.resumeSequence)
        ).then((sequence) => ({ kind: "resume" as const, sequence })),
      ]);
      if (progress.kind === "resume" && progress.sequence !== undefined) {
        observer.resumeSequence = progress.sequence;
        return;
      }
      completed = progress.kind === "complete" ? progress.result : await observer.stop;
    } else {
      completed = await observer.stop;
    }

    if (completed?.stop.disposition === "preempted") return completed;

    await this.#invoke(observer.component, "startRun", () =>
      observer.component.startRun({
        runId,
        role: "observer",
        action: { kind: "continue" },
      })
    );
    observer.stop = this.#invoke(observer.component, "waitForStop", () =>
      observer.component.waitForStop(runId)
    ).then((stop) => ({ component: observer.component, stop }));
    observer.resumeSequence =
      (await this.#invoke(observer.component, "waitForPhysicalResume", () =>
        observer.component.waitForPhysicalResume?.(runId, 0)
      )) ?? 0;
  }

  #waitForObserverPreemption(
    observers: ComponentRunWait[]
  ): Promise<{ component: SourceDebuggerComponentInstance; stop: ComponentStop }> {
    return Promise.race(
      observers.map(({ stop }) =>
        stop.then((result) =>
          result.stop.disposition === "preempted" ? result : new Promise<never>(() => {})
        )
      )
    );
  }

  async #commitPreemptedStop(
    preempted: { component: SourceDebuggerComponentInstance; stop: ComponentStop },
    driverWait: Promise<{ component: SourceDebuggerComponentInstance; stop: ComponentStop }>,
    observers: ComponentRunWait[],
    runId: RunId
  ): Promise<SessionState & { output?: string }> {
    const interrupted = this.#activeComponents().filter(
      (component) => component !== preempted.component
    );
    this.#logger.debug(
      `[session] ${runId} aborting ${interrupted.map(({ id }) => id).join(", ")} for ${preempted.component.id}`
    );
    await Promise.all(
      interrupted.map((component) =>
        this.#invoke(component, "preempt run", () =>
          component.abortRun
            ? component.abortRun(runId)
            : component.synchronizeRun
              ? component.synchronizeRun(runId)
              : component.cancelRun(runId)
        )
      )
    );
    return this.#commitRunStop([
      preempted,
      await driverWait,
      ...(await Promise.all(
        observers
          .filter(({ component }) => component !== preempted.component)
          .map(({ stop }) => stop)
      )),
    ]);
  }

  #commitRunStop(
    results: Array<{
      component: SourceDebuggerComponentInstance;
      stop: Awaited<ReturnType<SourceDebuggerComponentInstance["waitForStop"]>>;
    }>
  ): SessionState & { output?: string } {
    const accepted =
      results.find(({ stop }) => stop.disposition === "preempted") ??
      results.find(({ stop }) => stop.disposition === "accepted") ??
      results[0];
    this.#stateComponentId = accepted.component.id;
    this.#advanceStop();
    return {
      stopId: this.#stopId,
      reason: accepted.stop.reason,
      ...(accepted.stop.output ? { output: accepted.stop.output } : {}),
    };
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
    const component = this.#knownComponent(id);
    const failure = this.#quarantined.get(id);
    if (failure) throw new ComponentUnavailableError(id, failure);
    return component;
  }

  #knownComponent(id: ComponentId): SourceDebuggerComponentInstance {
    const component = this.#componentById.get(id);
    if (!component) throw new Error(`unknown SourceDebuggerComponent ${id}`);
    return component;
  }

  #activeComponents(): SourceDebuggerComponentInstance[] {
    return this.#components.filter((component) => !this.#quarantined.has(component.id));
  }

  async #invoke<T>(
    component: SourceDebuggerComponentInstance,
    operation: string,
    invoke: () => T | Promise<T>
  ): Promise<T> {
    const prior = this.#quarantined.get(component.id);
    if (prior) throw new ComponentUnavailableError(component.id, prior);
    try {
      return await invoke();
    } catch (error) {
      if (!isSourceDebuggerRpcTransportError(error)) throw error;
      this.#quarantine(component, operation, error);
      throw new ComponentUnavailableError(component.id, error);
    }
  }

  #quarantine(component: SourceDebuggerComponentInstance, operation: string, error: Error): void {
    if (this.#quarantined.has(component.id)) return;
    this.#quarantined.set(component.id, error);
    for (const [id, frame] of this.#frames) {
      if (frame.componentId === component.id) this.#frames.delete(id);
    }
    for (const [id, route] of this.#breakpointRoutes) {
      if (route.component === component) this.#breakpointRoutes.delete(id);
    }
    this.#logger.error(
      `[session] quarantined SourceDebuggerComponent ${component.id} during ${operation}: ${error.message}`
    );
  }

  async #firstAvailable<T>(
    operation: string,
    invoke: (component: SourceDebuggerComponentInstance) => Promise<T>,
    preferredId?: ComponentId
  ): Promise<T> {
    const active = this.#activeComponents();
    const preferred = preferredId ? active.find(({ id }) => id === preferredId) : undefined;
    const ordered = preferred
      ? [preferred, ...active.filter((component) => component !== preferred)]
      : active;
    for (const component of ordered) {
      try {
        return await this.#invoke(component, operation, () => invoke(component));
      } catch (error) {
        if (error instanceof ComponentUnavailableError) continue;
        throw error;
      }
    }
    throw new Error(`no available SourceDebuggerComponent can provide ${operation}`);
  }

  async #collectAvailable<T>(
    operation: string,
    invoke: (component: SourceDebuggerComponentInstance) => Promise<T>
  ): Promise<T[]> {
    const components = this.#activeComponents();
    const results = await Promise.allSettled(
      components.map((component) => this.#invoke(component, operation, () => invoke(component)))
    );
    const values: T[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") values.push(result.value);
      else if (!(result.reason instanceof ComponentUnavailableError)) throw result.reason;
    }
    if (values.length === 0 && components.length > 0) {
      throw new Error(`no available SourceDebuggerComponent can provide ${operation}`);
    }
    return values;
  }

  #unambiguousComponent(operation: string): SourceDebuggerComponentInstance {
    const active = this.#activeComponents();
    if (active.length !== 1) {
      throw new Error(`${operation} requires an explicit component in a multi-component session`);
    }
    return active[0];
  }
}

class ComponentUnavailableError extends Error {
  constructor(
    readonly componentId: ComponentId,
    cause: Error
  ) {
    super(`SourceDebuggerComponent ${componentId} is quarantined: ${cause.message}`, { cause });
    this.name = "SourceDebuggerComponentUnavailableError";
  }
}

function isRunControlCommand(command: string): boolean {
  return /^\s*(?:c|continue|process\s+continue|run|r|thread\s+(?:step|step-in|step-over|step-out|step-inst))\b/i.test(
    command
  );
}

function sameSourceStack(before: LogicalFrame[], after: LogicalFrame[]): boolean {
  return (
    before.length === after.length &&
    before.every((frame, index) => sourceFrameKey(frame) === sourceFrameKey(after[index]))
  );
}

function sourceFrameKey(frame: LogicalFrame): string {
  const location = frame.location
    ? `${frame.location.sourceId}:${frame.location.line}:${frame.location.column ?? ""}`
    : frame.pc;
  return [
    frame.componentId,
    frame.functionName,
    location ?? "",
    frame.inline ? "inline" : "physical",
    frame.inlineFrameIndex,
  ].join("\u0000");
}

function isForeignEntryTrap(reason: SessionState["reason"]): boolean {
  return reason.kind === "stopped" || (reason.kind === "signal" && reason.signal === "SIGTRAP");
}
