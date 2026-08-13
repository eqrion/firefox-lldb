/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { noopLogger, type Logger } from "../../logging.js";
import type { SourceDebuggerComponent, SourceDebuggerRun } from "../protocol/component.js";
import type { SourceDebuggerSessionHost } from "../target/host.js";
import type { SourceDebuggerTarget } from "../protocol/target.js";
import { SourceDebuggerError } from "../protocol/error.js";
import {
  validateComponentDescriptor,
  validateComponentFrame,
  validateComponentStop,
  validateRunResource,
  validateSourceValue,
} from "../protocol/validation.js";
import type { ModuleOwnerResolver } from "./ownership.js";
import { isSourceDebuggerRpcTransportError } from "../transport/rpc.js";
import type {
  BreakpointId,
  CommandResult,
  ComponentId,
  ComponentRunAction,
  ComponentRunRequest,
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
  SourceFile,
  SourceId,
  SourceProperty,
  ValueId,
} from "../protocol/types.js";

export interface SourceDebuggerSessionOptions {
  components: SourceDebuggerComponent[];
  target?: SourceDebuggerTarget;
  resolveModuleOwner?: ModuleOwnerResolver;
  /** Lazily create and attach an installed component selected for a module
   * which appeared after initial discovery. Called only while stopped. */
  ensureComponent?: (componentId: ComponentId) => Promise<SourceDebuggerComponent>;
  /** Imported debuggee capabilities owned and revoked with this session. */
  debuggeeHost?: SourceDebuggerSessionHost;
  logger?: Logger;
}

interface BreakpointRoute {
  component: SourceDebuggerComponent;
  componentBreakpointId: string;
}

interface SourceRoute {
  component: SourceDebuggerComponent;
  componentSourceId: SourceId;
  moduleId?: string;
}

interface ValueRoute {
  component: SourceDebuggerComponent;
  componentValueId: ValueId;
  stopId: StopId;
}

interface ComponentRunWait {
  component: SourceDebuggerComponent;
  run: SourceDebuggerRun;
  stop: Promise<{ component: SourceDebuggerComponent; stop: ComponentStop }>;
}

const MAX_TRANSPARENT_STEP_IN_STOPS = 32;

// Language-neutral coordinator for one browser debug target. Components
// project only the physical frames they own. Run control is coordinated with
// an observer-first barrier so isolated debuggers enter each physical run
// before its driver is allowed to resume the target.
export class SourceDebuggerSession {
  readonly #components: SourceDebuggerComponent[];
  readonly #componentById: Map<ComponentId, SourceDebuggerComponent>;
  readonly #target: SourceDebuggerTarget | undefined;
  readonly #resolveModuleOwner: ModuleOwnerResolver;
  readonly #ensureComponent:
    | ((componentId: ComponentId) => Promise<SourceDebuggerComponent>)
    | undefined;
  readonly #debuggeeHost: SourceDebuggerSessionHost | undefined;
  readonly #logger: Logger;
  readonly #frames = new Map<LogicalFrameId, LogicalFrame>();
  readonly #sourceRoutes = new Map<SourceId, SourceRoute>();
  readonly #valueRoutes = new Map<ValueId, ValueRoute>();
  readonly #breakpointRoutes = new Map<BreakpointId, BreakpointRoute>();
  readonly #componentDescriptors = new Map<ComponentId, SourceDebuggerComponentDescriptor>();
  readonly #quarantined = new Map<ComponentId, Error>();
  #moduleById = new Map<string, ModuleDescriptor>();
  #moduleSync: Promise<ModuleDescriptor[]> | undefined;
  #stopNumber = 0;
  #runNumber = 0;
  #stopId: StopId = "stop-0";
  #activeRunId: RunId | undefined;
  #activeRuns: ComponentRunWait[] = [];
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
    this.#target = options.target;
    this.#resolveModuleOwner = options.resolveModuleOwner ?? (async () => this.#components[0].id);
    this.#ensureComponent = options.ensureComponent;
    this.#debuggeeHost = options.debuggeeHost;
    this.#logger = options.logger ?? noopLogger;
    this.#stateComponentId = this.#components[0].id;
  }

  currentStopId(): StopId {
    return this.#stopId;
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
          // Status is also the liveness probe. Do not serve the cached
          // descriptor here or an exited isolate would remain "ready" until a
          // different operation happened to touch it.
          const descriptor = validateComponentDescriptor(
            await this.#invoke(component, "describe", () => component.describe()),
            component.id
          );
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

  async sources(moduleId?: string): Promise<SourceFile[]> {
    await this.modules();
    if (moduleId) {
      const module = this.#moduleById.get(moduleId);
      if (!module) throw new Error(`unknown Wasm module ${moduleId}`);
      const component = this.#component(module.owner);
      const sources = await this.#invoke(component, "sources", () => component.sources(moduleId));
      return sources.map((source) => this.#routeSource(component, source));
    }
    const sources = await this.#collectAvailable("sources", async (component) =>
      (await component.sources()).map((source) => this.#routeSource(component, source))
    );
    return sources.flat();
  }

  async source(sourceId: string): Promise<SourceFile | undefined> {
    return (await this.sources()).find(({ id }) => id === sourceId);
  }

  async sourceContent(sourceId: SourceId): Promise<string | null> {
    if (!this.#sourceRoutes.has(sourceId)) await this.sources();
    const route = this.#sourceRoutes.get(sourceId);
    if (!route) throw new SourceDebuggerError("not-found", `unknown source ${sourceId}`);
    return this.#invoke(route.component, "source content", () =>
      route.component.sourceContent(route.componentSourceId)
    );
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
          validateComponentFrame(component.id, frame);
          const id = [
            this.#stopId,
            selectedThread,
            frame.physicalFrameIndex,
            frame.inlineFrameIndex,
            component.id,
          ].join(":");
          const logical: LogicalFrame = {
            ...frame,
            ...(frame.location
              ? {
                  location: {
                    ...frame.location,
                    sourceId: this.#logicalSourceId(component, frame.location.sourceId),
                  },
                }
              : {}),
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
    const scopes = await this.#invoke(component, "scopes", () =>
      component.scopes(this.#stopId, frame.componentFrameId)
    );
    return scopes.map((scope) => ({
      ...scope,
      values: scope.values.map((property) => this.#routeProperty(component, property)),
    }));
  }

  async evaluate(frameId: LogicalFrameId, expression: string): Promise<SourceValue | null> {
    const frame = this.#frame(frameId);
    const component = this.#component(frame.componentId);
    await this.#requireCapability(component, "evaluate", "evaluate");
    const value = await this.#invoke(component, "evaluate", () =>
      component.evaluate(this.#stopId, frame.componentFrameId, expression)
    );
    return value ? this.#routeValue(component, value) : null;
  }

  async valueChildren(valueId: ValueId): Promise<SourceProperty[]> {
    const route = this.#valueRoutes.get(valueId);
    if (!route || route.stopId !== this.#stopId) {
      throw new SourceDebuggerError("invalid-state", `stale or unknown value ${valueId}`);
    }
    const children = await this.#invoke(route.component, "value children", () =>
      route.component.valueChildren(this.#stopId, route.componentValueId)
    );
    return children.map((property) => this.#routeProperty(route.component, property));
  }

  async setBreakpoint(request: SessionBreakpointRequest): Promise<SourceBreakpoint> {
    await this.modules();
    const sourceRoute =
      request.target.kind === "source"
        ? this.#sourceRoutes.get(request.target.location.sourceId)
        : undefined;
    const component = request.componentId
      ? this.#component(request.componentId)
      : (sourceRoute?.component ?? this.#unambiguousComponent("breakpoint"));
    await this.#requireCapability(component, "breakpoints", "set breakpoint");
    if (request.condition || request.hitCondition) {
      await this.#requireCapability(
        component,
        "conditionalBreakpoints",
        "set conditional breakpoint"
      );
    }
    if (sourceRoute && sourceRoute.component !== component) {
      throw new Error(
        `source ${sourceRoute.componentSourceId} belongs to component ${sourceRoute.component.id}, not ${component.id}`
      );
    }
    const componentRequest: SessionBreakpointRequest =
      request.target.kind === "source" && sourceRoute
        ? {
            ...request,
            target: {
              kind: "source",
              location: {
                ...request.target.location,
                sourceId: sourceRoute.componentSourceId,
              },
            },
          }
        : request;
    const breakpoint = await this.#invoke(component, "setBreakpoint", () =>
      component.setBreakpoint(componentRequest)
    );
    const id = `${component.id}:${breakpoint.id}`;
    this.#breakpointRoutes.set(id, {
      component,
      componentBreakpointId: breakpoint.id,
    });
    return { ...breakpoint, id, target: request.target };
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
        componentId: component.id,
        target:
          breakpoint.target.kind === "source"
            ? {
                kind: "source" as const,
                location: {
                  ...breakpoint.target.location,
                  sourceId: this.#logicalSourceId(component, breakpoint.target.location.sourceId),
                },
              }
            : breakpoint.target,
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
    if (!this.#activeRunId) return;
    await Promise.allSettled(
      this.#activeRuns.map(({ component, run }) =>
        this.#invoke(component, "cancel run", () => run.terminate("cancel"))
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
    this.#sourceRoutes.clear();
    this.#valueRoutes.clear();
    this.#breakpointRoutes.clear();
    this.#componentDescriptors.clear();
    this.#moduleById.clear();
    this.#quarantined.clear();
  }

  async #refreshModules(): Promise<ModuleDescriptor[]> {
    const modules = (await this.#target?.modules()) ?? [];
    const next = new Map<string, ModuleDescriptor>();
    for (const module of modules) {
      const existing = next.get(module.id) ?? this.#moduleById.get(module.id);
      if (existing) {
        next.set(existing.id, existing);
        continue;
      }
      if (this.#activeRunId) {
        throw new Error(
          `cannot assign newly loaded Wasm module ${module.url} during active run ${this.#activeRunId}`
        );
      }
      // Ownership is sticky for the lifetime of a loaded module. Re-running
      // discovery on every refresh could silently move it between debuggers if
      // a component is installed, removed, or changes its probe result.
      const owner = await this.#resolveModuleOwner(module);
      this.#target?.assignModuleOwner?.(module.id, owner);
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

    for (const id of this.#moduleById.keys()) {
      if (!next.has(id)) {
        this.#target?.removeModuleOwner?.(id);
        for (const [sourceId, route] of this.#sourceRoutes) {
          if (route.moduleId === id) this.#sourceRoutes.delete(sourceId);
        }
      }
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
    const runCapability = capabilityForRunAction(action);
    if (runCapability) await this.#requireCapability(driver, runCapability, action.kind);
    const runId: RunId = `run-${++this.#runNumber}`;
    this.#activeRunId = runId;
    const runs: ComponentRunWait[] = [];
    this.#activeRuns = runs;
    try {
      // Observers arm first so no component can miss a fast physical stop when
      // the driver starts its underlying RSP operation.
      const armed = await Promise.allSettled(
        active
          .filter((component) => component !== driver)
          .map(async (component) => {
            const request: ComponentRunRequest = {
              runId,
              role: "observer",
              action: { kind: "continue" },
            };
            const run = await this.#invoke(component, "begin observer run", () =>
              component.beginRun(request)
            );
            validateRunResource(component.id, request, run);
            const wait = this.#runWait(component, run);
            await this.#invoke(component, "arm observer resume", () => run.waitForResume());
            return wait;
          })
      );
      for (const result of armed) {
        if (result.status === "fulfilled") runs.push(result.value);
        else if (!(result.reason instanceof ComponentUnavailableError)) throw result.reason;
      }
      this.#logger.debug(`[session] ${runId} observers armed; starting ${driver.id}`);
      const driverRequest: ComponentRunRequest = { runId, role: "driver", action };
      const driverRun = await this.#invoke(driver, "begin driver run", () =>
        driver.beginRun(driverRequest)
      );
      validateRunResource(driver.id, driverRequest, driverRun);
      const driverWait = this.#runWait(driver, driverRun);
      runs.push(driverWait);
      this.#logger.debug(`[session] ${runId} driver armed`);
      const observerWaits = runs.filter((wait) => wait !== driverWait);
      const firstResume = await this.#invoke(driver, "wait for physical resume", () =>
        driverRun.waitForResume()
      );
      this.#logger.debug(`[session] ${runId} first driver resume ${firstResume?.token ?? "none"}`);
      if (firstResume !== undefined) {
        await this.#invoke(driver, "grant physical resume", () =>
          driverRun.grantResume(firstResume)
        );
        for (;;) {
          this.#logger.debug(`[session] ${runId} waiting after driver resume ${firstResume.token}`);
          const progress = await Promise.race([
            driverWait.stop.then((result) => ({ kind: "complete" as const, result })),
            this.#invoke(driver, "wait for physical resume", () => driverRun.waitForResume()).then(
              (request) => ({ kind: "resume" as const, request })
            ),
            this.#waitForObserverPreemption(observerWaits).then((result) => ({
              kind: "preempted" as const,
              result,
            })),
          ]);
          if (progress.kind === "preempted") {
            this.#logger.debug(`[session] ${runId} preempted by ${progress.result.component.id}`);
            return this.#commitPreemptedStop(progress.result, runs, runId);
          }
          if (progress.kind === "complete" || progress.request === undefined) {
            const result = progress.kind === "complete" ? progress.result : await driverWait.stop;
            await Promise.all(
              observerWaits.map(({ component, run }) =>
                this.#invoke(component, "synchronize run", () => run.terminate("synchronize"))
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
            observerWaits.map((observer) => this.#prepareObserverResume(observer))
          );
          const preempted = prepared.find((result) => result !== undefined);
          if (preempted) {
            return this.#commitPreemptedStop(preempted, runs, runId);
          }
          const request = progress.request;
          await this.#invoke(driver, "grant physical resume", () => driverRun.grantResume(request));
        }
      }

      const waits = runs.map(({ stop }) => stop);
      const first = await Promise.race(waits);
      await Promise.all(
        runs
          .filter(({ component }) => component !== first.component)
          .map(({ component, run }) =>
            this.#invoke(component, "terminate run", () =>
              run.terminate(first.stop.disposition === "preempted" ? "preempt" : "synchronize")
            )
          )
      );
      return this.#commitRunStop(await Promise.all(waits));
    } catch (error) {
      await Promise.allSettled(
        runs.map(({ component, run }) =>
          this.#invoke(component, "cancel run", () => run.terminate("cancel"))
        )
      );
      if (error instanceof ComponentUnavailableError) this.#advanceStop();
      throw error;
    } finally {
      await Promise.allSettled(
        runs.map(({ component, run }) =>
          this.#invoke(component, "dispose run", () => run.dispose())
        )
      );
      if (this.#activeRunId === runId) {
        this.#activeRunId = undefined;
        this.#activeRuns = [];
      }
    }
  }

  #runWait(component: SourceDebuggerComponent, run: SourceDebuggerRun): ComponentRunWait {
    const stop = this.#invoke(component, "wait for stop", () => run.waitForStop()).then(
      (componentStop) => ({
        component,
        stop: validateComponentStop(component.id, run.id, componentStop),
      })
    );
    // A sibling run can fail while this component is still armed. Keep the
    // concurrent stop rejection observed until the session terminates all runs.
    void stop.catch(() => {});
    return {
      component,
      run,
      stop,
    };
  }

  async #prepareObserverResume(
    observer: ComponentRunWait
  ): Promise<{ component: SourceDebuggerComponent; stop: ComponentStop } | undefined> {
    const progress = await Promise.race([
      observer.stop.then((result) => ({ kind: "complete" as const, result })),
      this.#invoke(observer.component, "wait for observer resume", () =>
        observer.run.waitForResume()
      ).then((request) => ({ kind: "resume" as const, request })),
    ]);
    if (progress.kind === "resume" && progress.request !== undefined) {
      return;
    }
    const completed = progress.kind === "complete" ? progress.result : await observer.stop;

    if (completed?.stop.disposition === "preempted") return completed;

    await this.#invoke(observer.component, "rearm observer", () => observer.run.rearmObserver());
    observer.stop = this.#invoke(observer.component, "wait for stop", () =>
      observer.run.waitForStop()
    ).then((stop) => ({ component: observer.component, stop }));
    await this.#invoke(observer.component, "arm observer resume", () =>
      observer.run.waitForResume()
    );
  }

  #waitForObserverPreemption(
    observers: ComponentRunWait[]
  ): Promise<{ component: SourceDebuggerComponent; stop: ComponentStop }> {
    return Promise.race(
      observers.map(({ stop }) =>
        stop.then((result) =>
          result.stop.disposition === "preempted" ? result : new Promise<never>(() => {})
        )
      )
    );
  }

  async #commitPreemptedStop(
    preempted: { component: SourceDebuggerComponent; stop: ComponentStop },
    runs: ComponentRunWait[],
    runId: RunId
  ): Promise<SessionState & { output?: string }> {
    const interrupted = runs.filter(({ component }) => component !== preempted.component);
    this.#logger.debug(
      `[session] ${runId} aborting ${interrupted.map(({ component }) => component.id).join(", ")} for ${preempted.component.id}`
    );
    await Promise.all(
      interrupted.map(({ component, run }) =>
        this.#invoke(component, "preempt run", () => run.terminate("preempt"))
      )
    );
    return this.#commitRunStop([
      preempted,
      ...(await Promise.all(
        runs.filter(({ component }) => component !== preempted.component).map(({ stop }) => stop)
      )),
    ]);
  }

  #commitRunStop(
    results: Array<{
      component: SourceDebuggerComponent;
      stop: ComponentStop;
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
    this.#valueRoutes.clear();
  }

  #routeSource(component: SourceDebuggerComponent, source: SourceFile): SourceFile {
    const id = this.#logicalSourceId(component, source.id);
    this.#sourceRoutes.set(id, {
      component,
      componentSourceId: source.id,
      ...(source.moduleId ? { moduleId: source.moduleId } : {}),
    });
    return { ...source, id };
  }

  #logicalSourceId(component: SourceDebuggerComponent, componentSourceId: SourceId): SourceId {
    const id = `source:${encodeURIComponent(component.id)}:${encodeURIComponent(componentSourceId)}`;
    if (!this.#sourceRoutes.has(id)) {
      this.#sourceRoutes.set(id, { component, componentSourceId });
    }
    return id;
  }

  #routeProperty(component: SourceDebuggerComponent, property: SourceProperty): SourceProperty {
    return { ...property, value: this.#routeValue(component, property.value) };
  }

  #routeValue(component: SourceDebuggerComponent, value: SourceValue): SourceValue {
    validateSourceValue(component.id, value);
    if (!value.id) return value;
    const id = `value:${encodeURIComponent(this.#stopId)}:${encodeURIComponent(component.id)}:${encodeURIComponent(value.id)}`;
    this.#valueRoutes.set(id, {
      component,
      componentValueId: value.id,
      stopId: this.#stopId,
    });
    return { ...value, id };
  }

  #frame(id: LogicalFrameId): LogicalFrame {
    const frame = this.#frames.get(id);
    if (!frame || frame.stopId !== this.#stopId) {
      throw new SourceDebuggerError("invalid-state", `stale or unknown frame ${id}`);
    }
    return frame;
  }

  #component(id: ComponentId): SourceDebuggerComponent {
    const component = this.#knownComponent(id);
    const failure = this.#quarantined.get(id);
    if (failure) throw new ComponentUnavailableError(id, failure);
    return component;
  }

  #knownComponent(id: ComponentId): SourceDebuggerComponent {
    const component = this.#componentById.get(id);
    if (!component) {
      throw new SourceDebuggerError("not-found", `unknown SourceDebuggerComponent ${id}`, {
        componentId: id,
      });
    }
    return component;
  }

  async #descriptor(
    component: SourceDebuggerComponent
  ): Promise<SourceDebuggerComponentDescriptor> {
    const cached = this.#componentDescriptors.get(component.id);
    if (cached) return cached;
    const descriptor = validateComponentDescriptor(
      await this.#invoke(component, "describe", () => component.describe()),
      component.id
    );
    this.#componentDescriptors.set(component.id, descriptor);
    return descriptor;
  }

  async #requireCapability(
    component: SourceDebuggerComponent,
    capability: keyof SourceDebuggerComponentDescriptor["capabilities"],
    operation: string
  ): Promise<void> {
    if ((await this.#descriptor(component)).capabilities[capability]) return;
    throw new SourceDebuggerError(
      "unsupported-operation",
      `SourceDebuggerComponent ${component.id} does not support ${operation}`,
      { componentId: component.id, operation }
    );
  }

  #activeComponents(): SourceDebuggerComponent[] {
    return this.#components.filter((component) => !this.#quarantined.has(component.id));
  }

  async #invoke<T>(
    component: SourceDebuggerComponent,
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

  #quarantine(component: SourceDebuggerComponent, operation: string, error: Error): void {
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
    invoke: (component: SourceDebuggerComponent) => Promise<T>,
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
    invoke: (component: SourceDebuggerComponent) => Promise<T>
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

  #unambiguousComponent(operation: string): SourceDebuggerComponent {
    const active = this.#activeComponents();
    if (active.length !== 1) {
      throw new SourceDebuggerError(
        "ambiguous",
        `${operation} requires an explicit component in a multi-component session`,
        { operation }
      );
    }
    return active[0];
  }
}

class ComponentUnavailableError extends SourceDebuggerError {
  constructor(
    override readonly componentId: ComponentId,
    cause: Error
  ) {
    super(
      "component-unavailable",
      `SourceDebuggerComponent ${componentId} is quarantined: ${cause.message}`,
      { componentId, cause }
    );
    this.name = "SourceDebuggerComponentUnavailableError";
  }
}

function isRunControlCommand(command: string): boolean {
  return /^\s*(?:c|continue|process\s+continue|run|r|thread\s+(?:step|step-in|step-over|step-out|step-inst))\b/i.test(
    command
  );
}

function capabilityForRunAction(
  action: ComponentRunAction
): keyof SourceDebuggerComponentDescriptor["capabilities"] | undefined {
  switch (action.kind) {
    case "continue":
      return undefined;
    case "step-into":
    case "prepare-frame":
      return "stepInto";
    case "step-over":
      return "stepOver";
    case "step-out":
      return "stepOut";
  }
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
