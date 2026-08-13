/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import type {
  ModuleClaim,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "./component.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import type {
  LoadedSourceDebuggerComponent,
  LoadedSourceDebuggerComponentDefinition,
  SourceDebuggerComponentLoader,
} from "./loader.js";
import type {
  ComponentFrame,
  ComponentRunRequest,
  ComponentStop,
  ModuleDescriptor,
  RunId,
  SessionState,
  SessionStopReason,
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
import type { WasmDebuggee, WasmDebuggeeStop } from "./wasm-debuggee.js";
import { generateWasmText, type GeneratedWasmText } from "./wasm-text.js";

export const WASM_SOURCE_DEBUGGER_ID = "wasm-text";

interface OwnedModule {
  descriptor: ModuleDescriptor;
  source: SourceFile;
  text: GeneratedWasmText;
}

interface InstalledBreakpoint {
  breakpoint: SourceBreakpoint;
  moduleId: string;
  requestedOffset: number;
  snappedOffset: number;
}

interface PendingRun {
  request: ComponentRunRequest;
  stop: Promise<ComponentStop>;
  released: boolean;
}

export class WasmSourceDebuggerComponentLoader implements SourceDebuggerComponentLoader {
  readonly id: string;

  constructor(
    id = WASM_SOURCE_DEBUGGER_ID,
    private readonly name = "WebAssembly Text"
  ) {
    this.id = id;
  }

  async loadDefinition(): Promise<LoadedSourceDebuggerComponentDefinition> {
    const definition = wasmSourceDebuggerDefinition(this.id, this.name);
    return {
      id: this.id,
      definition,
      probeModule: definition.probeModule,
      close: () => {},
    };
  }

  async instantiate(
    host: SourceDebuggerComponentHostBinding
  ): Promise<LoadedSourceDebuggerComponent> {
    if (!host.openWasmDebuggee) {
      throw new Error(`SourceDebuggerComponent host does not expose a direct Wasm debuggee`);
    }
    const debuggee = await host.openWasmDebuggee();
    const component = new WasmSourceDebuggerComponentInstance(debuggee, this.id, this.name);
    let closed = false;
    return {
      id: this.id,
      definition: wasmSourceDebuggerDefinition(this.id, this.name),
      component,
      probeModule: probeWasmSourceDebuggerModule,
      activate: async () => ({}),
      close: async () => {
        if (closed) return;
        closed = true;
        await component.dispose();
      },
    };
  }
}

export class WasmSourceDebuggerComponentInstance implements SourceDebuggerComponentInstance {
  readonly #modules = new Map<string, OwnedModule>();
  readonly #moduleBySourceId = new Map<string, OwnedModule>();
  readonly #breakpoints = new Map<string, InstalledBreakpoint>();
  readonly #runs = new Map<RunId, PendingRun>();
  readonly #threadByFrameId = new Map<string, string>();
  #nextBreakpointId = 1;
  #lastReason: SessionStopReason = { kind: "stopped" };
  #disposed = false;

  constructor(
    private readonly debuggee: WasmDebuggee,
    readonly id = WASM_SOURCE_DEBUGGER_ID,
    private readonly name = "WebAssembly Text"
  ) {}

  async describe(): Promise<SourceDebuggerComponentDescriptor> {
    return wasmSourceDebuggerDescriptor(this.id, this.name);
  }

  async addModules(modules: ModuleDescriptor[], _initialStop: StopId): Promise<void> {
    this.#requireOpen();
    for (const descriptor of modules) {
      if (descriptor.owner !== this.id) {
        throw new Error(`component ${this.id} cannot own ${descriptor.id}`);
      }
      if (this.#modules.has(descriptor.id)) continue;
      const [bytecode, offsets] = await Promise.all([
        this.debuggee.moduleBytecode(descriptor.id),
        this.debuggee.breakpointOffsets(descriptor.id),
      ]);
      const text = await generateWasmText(bytecode, offsets);
      const sourceId = `wasm-text://${createHash("sha256")
        .update(descriptor.id)
        .digest("hex")
        .slice(0, 16)}/module.wat`;
      const source: SourceFile = {
        id: sourceId,
        moduleId: descriptor.id,
        url: sourceId,
        language: "webassembly",
        content: text.content,
      };
      const module = { descriptor, source, text };
      this.#modules.set(descriptor.id, module);
      this.#moduleBySourceId.set(sourceId, module);
    }
  }

  async removeModules(moduleIds: string[]): Promise<void> {
    for (const moduleId of moduleIds) {
      const module = this.#modules.get(moduleId);
      if (!module) continue;
      for (const [id, installed] of this.#breakpoints) {
        if (installed.moduleId !== moduleId) continue;
        await this.debuggee
          .removeBreakpoint(installed.moduleId, installed.requestedOffset)
          .catch(() => {});
        this.#breakpoints.delete(id);
      }
      this.#modules.delete(moduleId);
      this.#moduleBySourceId.delete(module.source.id);
    }
  }

  async sources(moduleId?: string): Promise<SourceFile[]> {
    if (moduleId) {
      const module = this.#modules.get(moduleId);
      return module ? [module.source] : [];
    }
    return [...this.#modules.values()].map(({ source }) => source);
  }

  async state(stopId: StopId): Promise<SessionState> {
    return { stopId, reason: this.#lastReason };
  }

  async threads(_stopId: StopId): Promise<SessionThread[]> {
    return this.debuggee.threads();
  }

  async frames(_stopId: StopId, threadId: ThreadId): Promise<ComponentFrame[]> {
    this.#threadByFrameId.clear();
    return (await this.debuggee.frames(threadId)).flatMap((frame) => {
      const module = frame.moduleId ? this.#modules.get(frame.moduleId) : undefined;
      if (!module || frame.offset === undefined) return [];
      this.#threadByFrameId.set(frame.id, threadId);
      const line = module.text.lineForOffset(frame.offset);
      return [
        {
          id: frame.id,
          physicalFrameIndex: frame.physicalFrameIndex,
          inlineFrameIndex: 0,
          functionName:
            module.text.functionForOffset(frame.offset) ?? frame.functionName ?? "<wasm function>",
          ...(line
            ? { location: { sourceId: module.source.id, line } }
            : { pc: `0x${frame.offset.toString(16)}` }),
          inline: false,
        },
      ];
    });
  }

  async scopes(_stopId: StopId, frameId: string): Promise<SourceScope[]> {
    this.#requireFrame(frameId);
    const values = (await this.debuggee.frameVariables(frameId)).map((variable) => {
      const name = localName(variable.name);
      return {
        name,
        value: {
          name,
          ...(variable.type ? { type: variable.type } : {}),
          display: variable.display,
          hasChildren: false,
        },
      };
    });
    return [{ name: "Locals", kind: "locals", values }];
  }

  async evaluate(
    _stopId: StopId,
    frameId: string,
    expression: string
  ): Promise<SourceValue | null> {
    this.#requireFrame(frameId);
    const requested = expression.trim();
    const variable = (await this.debuggee.frameVariables(frameId)).find(
      ({ name }) => name === requested || localName(name) === requested
    );
    if (!variable) return null;
    const name = localName(variable.name);
    return {
      name,
      ...(variable.type ? { type: variable.type } : {}),
      display: variable.display,
      hasChildren: false,
    };
  }

  async setBreakpoint(request: SourceBreakpointRequest): Promise<SourceBreakpoint> {
    this.#requireOpen();
    if (request.condition || request.hitCondition) {
      return this.#unverifiedBreakpoint(request, "Wasm text breakpoints do not support conditions");
    }

    let module: OwnedModule | undefined;
    let offset: number | undefined;
    if (request.target.kind === "source") {
      module = this.#moduleBySourceId.get(request.target.location.sourceId);
      offset = module?.text.offsetForLine(request.target.location.line);
    } else {
      const functionName = request.target.name;
      const matches = [...this.#modules.values()].flatMap((candidate) => {
        const functionOffset = candidate.text.offsetForFunction(functionName);
        return functionOffset === undefined ? [] : [{ module: candidate, offset: functionOffset }];
      });
      if (matches.length === 1) ({ module, offset } = matches[0]);
      else if (matches.length > 1) {
        return this.#unverifiedBreakpoint(
          request,
          `function ${functionName} is present in more than one owned Wasm module`
        );
      }
    }
    if (!module || offset === undefined) {
      return this.#unverifiedBreakpoint(
        request,
        "no generated Wasm instruction matches the target"
      );
    }

    const id = String(this.#nextBreakpointId++);
    const snappedOffset = await this.debuggee.addBreakpoint(module.descriptor.id, offset);
    const breakpoint: SourceBreakpoint = {
      id,
      componentId: this.id,
      verified: true,
      target: request.target,
    };
    this.#breakpoints.set(id, {
      breakpoint,
      moduleId: module.descriptor.id,
      requestedOffset: offset,
      snappedOffset,
    });
    return breakpoint;
  }

  async removeBreakpoint(id: string): Promise<void> {
    const installed = this.#breakpoints.get(id);
    if (!installed) throw new Error(`unknown Wasm text breakpoint ${id}`);
    await this.debuggee.removeBreakpoint(installed.moduleId, installed.requestedOffset);
    this.#breakpoints.delete(id);
  }

  async breakpoints(): Promise<SourceBreakpoint[]> {
    return [...this.#breakpoints.values()].map(({ breakpoint }) => breakpoint);
  }

  async startRun(request: ComponentRunRequest): Promise<void> {
    this.#requireOpen();
    if (this.#runs.has(request.runId)) throw new Error(`run ${request.runId} already exists`);
    if (request.action.kind === "step-over" || request.action.kind === "step-out") {
      throw new Error(`${request.action.kind} is not implemented by the Wasm text debugger yet`);
    }
    const pending: PendingRun = {
      request,
      stop: Promise.resolve(undefined as never),
      released: false,
    };
    // waitForStop installs its listener synchronously, making startRun the
    // observer arm barrier even though stop classification itself is async.
    pending.stop = this.debuggee.waitForStop().then((stop) => this.#classifyStop(pending, stop));
    // A sibling can fail before the session reaches waitForStop(). Keep a
    // cancellation rejection observed even in that pre-wait arm window.
    void pending.stop.catch(() => {});
    this.#runs.set(request.runId, pending);
  }

  async waitForStop(runId: RunId): Promise<ComponentStop> {
    const pending = this.#runs.get(runId);
    if (!pending) throw new Error(`unknown run ${runId}`);
    try {
      return await pending.stop;
    } finally {
      this.#runs.delete(runId);
    }
  }

  waitForPhysicalResume(runId: RunId, afterSequence: number): Promise<number | undefined> {
    const pending = this.#runs.get(runId);
    if (!pending) return Promise.resolve(undefined);
    if (afterSequence < 1) return Promise.resolve(1);
    return pending.stop.then(() => undefined);
  }

  async releasePhysicalResume(runId: RunId, sequence: number): Promise<void> {
    const pending = this.#runs.get(runId);
    if (!pending || pending.request.role !== "driver" || sequence !== 1 || pending.released) return;
    pending.released = true;
    const action = pending.request.action;
    if (action.kind === "continue") {
      await this.debuggee.resume({ kind: "continue" });
      return;
    }
    const frameThread = action.frameId ? this.#threadByFrameId.get(action.frameId) : undefined;
    const stateThread = "threadId" in this.#lastReason ? this.#lastReason.threadId : undefined;
    const threadId = frameThread ?? stateThread ?? (await this.debuggee.threads())[0]?.id;
    if (!threadId) throw new Error("cannot step a Wasm target with no thread");
    await this.debuggee.resume({ kind: "step", threadId });
  }

  async synchronizeRun(_runId: RunId): Promise<void> {
    // A direct observer has already consumed the shared physical stop. It has
    // no private debugger engine or thread plan which needs cancellation.
  }

  async abortRun(_runId: RunId): Promise<void> {
    // Same as synchronization: one physical instruction/continue is the whole
    // plan, so there is no LLDB-like internal plan to abort at this stop.
  }

  async cancelRun(runId: RunId): Promise<void> {
    const pending = this.#runs.get(runId);
    if (!pending) return;
    if (pending.released) this.debuggee.interrupt();
    this.debuggee.cancelWaitForStop();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const installed of this.#breakpoints.values()) {
      await this.debuggee
        .removeBreakpoint(installed.moduleId, installed.requestedOffset)
        .catch(() => {});
    }
    this.#breakpoints.clear();
    this.#runs.clear();
    this.#modules.clear();
    this.#moduleBySourceId.clear();
    this.#threadByFrameId.clear();
    this.debuggee.dispose();
  }

  async #classifyStop(pending: PendingRun, stop: WasmDebuggeeStop): Promise<ComponentStop> {
    const frames = await this.debuggee.frames(stop.threadId);
    const owned = frames.find((frame) => frame.moduleId && this.#modules.has(frame.moduleId));
    const installed = owned
      ? [...this.#breakpoints.values()].find(
          ({ moduleId, snappedOffset }) =>
            moduleId === owned.moduleId && snappedOffset === owned.offset
        )
      : undefined;
    const reason: SessionStopReason = installed
      ? { kind: "breakpoint", threadId: stop.threadId, breakpointId: installed.breakpoint.id }
      : pending.request.action.kind === "continue"
        ? stop.reason
        : { kind: "step", threadId: stop.threadId };
    this.#lastReason = reason;
    const preempts = installed !== undefined || isPreemptingReason(reason);
    return {
      runId: pending.request.runId,
      disposition:
        pending.request.role === "driver" ? "accepted" : preempts ? "preempted" : "synchronized",
      reason,
    };
  }

  #unverifiedBreakpoint(request: SourceBreakpointRequest, message: string): SourceBreakpoint {
    return {
      id: `unresolved-${this.#nextBreakpointId++}`,
      componentId: this.id,
      verified: false,
      target: request.target,
      message,
    };
  }

  #requireFrame(frameId: string): void {
    if (!this.#threadByFrameId.has(frameId))
      throw new Error(`stale or unknown Wasm frame ${frameId}`);
  }

  #requireOpen(): void {
    if (this.#disposed) throw new Error(`SourceDebuggerComponent ${this.id} is disposed`);
  }
}

export function wasmSourceDebuggerDefinition(
  id = WASM_SOURCE_DEBUGGER_ID,
  name = "WebAssembly Text"
): SourceDebuggerComponentDefinition {
  return {
    describe: async () => wasmSourceDebuggerDescriptor(id, name),
    probeModule: probeWasmSourceDebuggerModule,
  };
}

export function wasmSourceDebuggerDescriptor(
  id = WASM_SOURCE_DEBUGGER_ID,
  name = "WebAssembly Text"
): SourceDebuggerComponentDescriptor {
  return {
    protocolVersion: "0.1",
    id,
    name,
    capabilities: {
      breakpoints: true,
      conditionalBreakpoints: false,
      evaluate: true,
      stepInto: true,
      stepOver: false,
      stepOut: false,
    },
  };
}

export async function probeWasmSourceDebuggerModule(
  module: Omit<ModuleDescriptor, "owner">
): Promise<ModuleClaim> {
  if (module.debugInfo?.includes("dwarf") || module.debugInfo?.includes("source-map")) {
    return {
      supported: false,
      confidence: 0,
      reason: "generated Wasm text is only the fallback when source metadata is absent",
    };
  }
  return { supported: true, confidence: 60, reason: "generated Wasm text fallback" };
}

function localName(name: string): string {
  const local = /^var([0-9]+)$/.exec(name);
  return local ? `$local${local[1]}` : name;
}

function isPreemptingReason(reason: SessionStopReason): boolean {
  return (
    reason.kind === "breakpoint" ||
    reason.kind === "exception" ||
    reason.kind === "interrupt" ||
    reason.kind === "exited"
  );
}
