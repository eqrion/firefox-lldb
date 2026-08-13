/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FrameForm, RdpWasmSession, StoppedEvent } from "../../rdp/session.js";
import { grip } from "../../rdp/session.js";
import type { SessionStopReason } from "../protocol/types.js";
import type {
  WasmDebuggee,
  WasmDebuggeeFrame,
  WasmDebuggeeModule,
  WasmDebuggeeResumeAction,
  WasmDebuggeeStop,
  WasmDebuggeeThread,
  WasmDebuggeeVariable,
} from "../protocol/wasm-debuggee.js";

/** Firefox/RDP implementation of the direct Wasm debuggee capability. One
 * instance is scoped to a SourceDebuggerComponent, but it borrows rather than
 * owns the shared physical RDP session. */
export class FirefoxWasmDebuggee implements WasmDebuggee {
  readonly #pendingStops = new Set<() => void>();
  #disposed = false;

  constructor(
    private readonly session: RdpWasmSession,
    private readonly acceptModule: (moduleId: string) => boolean = () => true
  ) {}

  async modules(): Promise<WasmDebuggeeModule[]> {
    this.#requireOpen();
    return (await this.session.wasmSources())
      .filter(({ url }) => this.acceptModule(url))
      .map(({ url }) => ({ id: url, url }));
  }

  async moduleBytecode(moduleId: string): Promise<Uint8Array> {
    this.#requireOpen();
    this.#requireModule(moduleId);
    return this.session.fetchModuleBytes(moduleId);
  }

  async breakpointOffsets(moduleId: string): Promise<number[]> {
    this.#requireOpen();
    this.#requireModule(moduleId);
    const source = (await this.session.wasmSources()).find(({ url }) => url === moduleId);
    if (!source) throw new Error(`unknown Wasm module ${moduleId}`);
    return this.session.wasmBreakpointOffsets(source.actor);
  }

  async threads(): Promise<WasmDebuggeeThread[]> {
    this.#requireOpen();
    const paused = new Set(this.session.pausedTids().map(String));
    return this.session
      .listTids()
      .map((tid) => ({ id: String(tid), stopped: paused.has(String(tid)) }));
  }

  async frames(threadId: string): Promise<WasmDebuggeeFrame[]> {
    this.#requireOpen();
    const tid = parseThreadId(threadId);
    // Refresh actor-to-URL mappings before interpreting frame locations.
    await this.session.wasmSources();
    return (await this.session.frames(tid)).flatMap((frame, physicalFrameIndex) => {
      if (frame.type !== "wasmcall" || !frame.where) return [];
      const moduleId = this.session.urlForSourceActor(frame.where.actor);
      return [
        {
          id: frame.actor,
          threadId,
          physicalFrameIndex,
          ...(moduleId ? { moduleId } : {}),
          offset: frame.where.line,
          ...(frameName(frame) ? { functionName: frameName(frame) } : {}),
        },
      ];
    });
  }

  async frameVariables(frameId: string): Promise<WasmDebuggeeVariable[]> {
    this.#requireOpen();
    const environment = (await this.session.frameEnvironment(frameId)) as {
      bindings?: {
        arguments?: Array<Record<string, { value?: unknown }>>;
        variables?: Record<string, { value?: unknown }>;
      };
    };
    const variables: WasmDebuggeeVariable[] = [];
    for (const argument of environment.bindings?.arguments ?? []) {
      for (const [name, descriptor] of Object.entries(argument)) {
        variables.push(value(name, descriptor.value));
      }
    }
    for (const [name, descriptor] of Object.entries(environment.bindings?.variables ?? {})) {
      variables.push(value(name, descriptor.value));
    }
    return variables;
  }

  addBreakpoint(moduleId: string, offset: number): Promise<number> {
    this.#requireOpen();
    this.#requireModule(moduleId);
    return this.session.setWasmBreakpoint(moduleId, offset);
  }

  async removeBreakpoint(moduleId: string, offset: number): Promise<void> {
    this.#requireOpen();
    this.#requireModule(moduleId);
    await this.session.removeWasmBreakpoint(moduleId, offset);
  }

  waitForStop(): Promise<WasmDebuggeeStop> {
    this.#requireOpen();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.session.off("stopped", onStopped);
        this.session.off("close", onClose);
        this.#pendingStops.delete(cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Wasm debuggee disposed while waiting for a stop"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Wasm debuggee session closed while waiting for a stop"));
      };
      const onStopped = (event: StoppedEvent) => {
        cleanup();
        resolve({
          threadId: String(event.tid),
          reason: stopReason(event),
        });
      };
      this.#pendingStops.add(cancel);
      this.session.once("stopped", onStopped);
      this.session.once("close", onClose);
    });
  }

  async cancelWaitForStop(): Promise<void> {
    for (const cancel of [...this.#pendingStops]) cancel();
  }

  async resume(action: WasmDebuggeeResumeAction): Promise<void> {
    this.#requireOpen();
    this.session.armAllStop();
    if (action.kind === "continue") await this.session.resumeAll();
    else this.session.stepOne(parseThreadId(action.threadId), "step");
  }

  async interrupt(): Promise<void> {
    this.#requireOpen();
    const tid = this.session.preferredInterruptTid();
    if (tid !== undefined) this.session.interrupt(tid);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cancel of [...this.#pendingStops]) cancel();
    this.#pendingStops.clear();
  }

  #requireOpen(): void {
    if (this.#disposed) throw new Error("Wasm debuggee is disposed");
  }

  #requireModule(moduleId: string): void {
    if (!this.acceptModule(moduleId)) {
      throw new Error(`Wasm module ${moduleId} is not owned by this debuggee capability`);
    }
  }
}

function parseThreadId(threadId: string): number {
  const tid = Number(threadId);
  if (!Number.isInteger(tid) || tid < 1) throw new Error(`invalid Wasm thread ${threadId}`);
  return tid;
}

function frameName(frame: FrameForm): string | undefined {
  return frame.callee?.displayName || frame.callee?.name;
}

function value(name: string, raw: unknown): WasmDebuggeeVariable {
  const type =
    typeof raw === "bigint"
      ? "i64"
      : typeof raw === "number"
        ? Number.isInteger(raw)
          ? "i32"
          : "f64"
        : undefined;
  return { name, ...(type ? { type } : {}), display: grip(raw) };
}

function stopReason(event: StoppedEvent): SessionStopReason {
  const threadId = String(event.tid);
  switch (event.pausePacket.why?.type) {
    case "exception":
      return { kind: "exception", threadId };
    case "interrupted":
      return { kind: "interrupt", threadId };
    default:
      return { kind: "stopped", threadId };
  }
}
