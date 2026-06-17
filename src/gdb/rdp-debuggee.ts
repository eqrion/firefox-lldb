/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Implements the gdbstub component's WIT `debuggee` interface (as dispatched
// over the worker SAB-RPC) on top of a live Firefox RDP session.
//
// Thread model: each Firefox thread actor maps to a gdbstub TID. Frames,
// locals, and globals are per-thread. Linear memory is shared — any stopped
// thread's `memory0` scope gives the same buffer.
//
// WIT changes vs the single-thread version:
//   - Debuggee.listThreads  -> session.listTids()
//   - Debuggee.stoppedThread -> session.stoppedTid
//   - Debuggee.exitFrames(tid) -> per-tid snapshot
//   - Debuggee.singleStep(tid, resumption) -> session.stepOne(tid)
//   - Debuggee.continue     -> session.resumeAll()
//   - EventFuture.finish    -> awaits all-stop "stopped" event, then snapshots

import type { RdpWasmSession, FrameForm, StoppedEvent } from "../rdp/session.js";

export interface RpcRequest {
  type: string;
  id: number;
  method: string;
  args: unknown[];
}

type Ref = { $res: string; id: number };

export class RdpDebuggee {
  #session: RdpWasmSession;
  #nextId = 1;

  // Stable module identity per source URL.
  #moduleByUrl = new Map<string, { id: number; url: string }>();
  #moduleById = new Map<number, { id: number; url: string }>();
  #sourceActorToUrl = new Map<string, string>();

  // Per-tid frame snapshots (innermost-first wasm frames, set on each stop).
  #framesByTid = new Map<number, FrameForm[]>();

  // Frame ref id -> {tid, index} (reset on each stop).
  #frameInfoById = new Map<number, { tid: number; index: number }>();

  // Instance refs (id -> module URL).
  #instanceUrlById = new Map<number, string>();

  // WasmValue refs (id -> {tag, raw}); raw is the JS value from RDP bindings.
  #valueById = new Map<number, { tag: string; raw: number | bigint }>();

  // Global refs (id -> global index in the instance's global index space).
  #globalIndexById = new Map<number, number>();

  // Per-tid innermost wasm frame actor (for memory/global reads in that thread's scope).
  #topFrameActorByTid = new Map<number, string | null>();

  // Resolves on the next all-stop "stopped" event (armed before resume/step).
  #stopped: Promise<StoppedEvent> = Promise.resolve({ tid: 1, pausePacket: {} });
  #resolveStopped: ((e: StoppedEvent) => void) | null = null;
  #lastPauseReason = "breakpoint";

  // Fired once on LLDB's first continue (drives the page's wasm export
  // after a breakpoint is armed, so the engine pauses inside wasm).
  #onFirstContinue: (() => void) | null = null;

  constructor(session: RdpWasmSession, opts?: { onFirstContinue?: () => void }) {
    this.#session = session;
    this.#onFirstContinue = opts?.onFirstContinue ?? null;

    // Listen for all-stop completion; resolve the current #stopped promise.
    session.on("stopped", (e: StoppedEvent) => {
      this.#lastPauseReason = (e.pausePacket as { why?: { type?: string } })?.why?.type ?? "breakpoint";
      this.#resolveStopped?.(e);
      this.#resolveStopped = null;
    });
  }

  async dispatch(req: RpcRequest): Promise<unknown> {
    const { type, id, method, args } = req;
    const key = `${type}.${method}`;
    switch (key) {
      case "Debuggee.allModules":
        return this.#allModules();
      case "Debuggee.allInstances":
        return this.#allInstances();
      case "Debuggee.listThreads":
        return this.#session.listTids();
      case "Debuggee.stoppedThread":
        return this.#session.stoppedTid;
      case "Debuggee.exitFrames": {
        const tid = args[0] as number;
        return this.#exitFrames(tid);
      }
      case "Debuggee.continue": {
        this.#armStopped();
        // Arm BEFORE resuming so we don't miss a pause from a very fast execution.
        this.#session.armAllStop();
        this.#session.resumeAll().catch(() => {});
        const cb = this.#onFirstContinue;
        this.#onFirstContinue = null;
        cb?.();
        return this.#eventFutureRef();
      }
      case "Debuggee.singleStep": {
        const tid = args[0] as number;
        this.#armStopped();
        this.#session.armAllStop();
        this.#session.stepOne(tid).catch(() => {});
        return this.#eventFutureRef();
      }
      case "Debuggee.interrupt": {
        // Interrupt the stopped thread; all-stop already has all others paused.
        this.#armStopped();
        this.#session.interrupt(this.#session.stoppedTid).catch(() => {});
        return null;
      }
      case "EventFuture.finish": {
        await this.#stopped;
        await this.#snapshotAll();
        return { tag: this.#eventTag() };
      }

      case "Module.uniqueId":
        return BigInt(id);
      case "Module.bytecode":
        return this.#session.fetchModuleBytes(this.#moduleById.get(id)!.url);
      case "Module.addBreakpoint":
        await this.#session.setWasmBreakpoint(
          this.#moduleById.get(id)!.url,
          args[0] as number
        );
        return null;
      case "Module.removeBreakpoint":
        await this.#session.removeWasmBreakpoint(
          this.#moduleById.get(id)!.url,
          args[0] as number
        );
        return null;

      case "Instance.getModule":
        return this.#moduleRef(this.#instanceUrlById.get(id)!);
      case "Instance.uniqueId":
        return BigInt(this.#moduleByUrl.get(this.#instanceUrlById.get(id)!)!.id);
      case "Instance.getMemory":
        return (args[0] as number) === 0
          ? { $res: "Memory", id: this.#nextId++ }
          : Promise.reject(Object.assign(new Error("out-of-bounds"), { payload: "out-of-bounds" }));
      case "Instance.getGlobal": {
        const gid = this.#nextId++;
        this.#globalIndexById.set(gid, args[0] as number);
        return { $res: "Global", id: gid };
      }

      case "Global.get":
        return this.#readGlobal(this.#globalIndexById.get(id)!);
      case "Global.uniqueId":
        return BigInt(this.#globalIndexById.get(id)!);
      case "Global.clone": {
        const gid = this.#nextId++;
        this.#globalIndexById.set(gid, this.#globalIndexById.get(id)!);
        return { $res: "Global", id: gid };
      }

      case "Memory.uniqueId":
        return 1n;
      case "Memory.sizeBytes":
        return BigInt(await this.#memorySize());
      case "Memory.pageSizeBytes":
        return 65536n;
      case "Memory.getBytes":
        return this.#readMemory(Number(args[0] as bigint), Number(args[1] as bigint));

      case "Frame.getInstance":
        return this.#frameInstance(id);
      case "Frame.getFuncIndex":
        return 0;
      case "Frame.getPc": {
        const fi = this.#frameInfoById.get(id)!;
        return this.#framesByTid.get(fi.tid)?.[fi.index]?.where?.line ?? 0;
      }
      case "Frame.getLocals":
        return this.#localsForFrame(id);
      case "Frame.getStack":
        return []; // operand stack not exposed
      case "Frame.parentFrame":
        return this.#parentFrame(id);

      case "WasmValue.getType":
        return { tag: this.#valueById.get(id)!.tag };
      case "WasmValue.unwrapI32":
        return Number(this.#valueById.get(id)!.raw) >>> 0;
      case "WasmValue.unwrapI64":
        return BigInt(this.#valueById.get(id)!.raw);
      case "WasmValue.unwrapF32":
      case "WasmValue.unwrapF64":
        return Number(this.#valueById.get(id)!.raw);
      case "WasmValue.clone": {
        const v = this.#valueById.get(id)!;
        const newId = this.#nextId++;
        this.#valueById.set(newId, v);
        return { $res: "WasmValue", id: newId };
      }

      default:
        throw new Error(`RdpDebuggee: unhandled ${key}`);
    }
  }

  // --- modules -------------------------------------------------------------
  async #allModules(): Promise<Ref[]> {
    const sources = await this.#session.wasmSources();
    this.#sourceActorToUrl.clear();
    const refs: Ref[] = [];
    for (const s of sources) {
      this.#sourceActorToUrl.set(s.actor, s.url);
      refs.push(this.#moduleRef(s.url));
    }
    return refs;
  }

  #moduleRef(url: string): Ref {
    let m = this.#moduleByUrl.get(url);
    if (!m) {
      m = { id: this.#nextId++, url };
      this.#moduleByUrl.set(url, m);
      this.#moduleById.set(m.id, m);
    }
    return { $res: "Module", id: m.id };
  }

  // --- instances -----------------------------------------------------------
  async #allInstances(): Promise<Ref[]> {
    const sources = await this.#session.wasmSources();
    return sources.length ? [this.#instanceRef(sources[0].url)] : [];
  }

  // --- frames --------------------------------------------------------------
  async #snapshotAll(): Promise<void> {
    // Refresh frames for every known thread; clear stale refs.
    this.#frameInfoById.clear();
    const tids = this.#session.listTids();
    for (const tid of tids) {
      let frames: FrameForm[] = [];
      try {
        frames = (await this.#session.frames(tid)).filter(
          (f) => f.type === "wasmcall" && f.where
        );
      } catch {
        frames = [];
      }
      this.#framesByTid.set(tid, frames);
      this.#topFrameActorByTid.set(tid, frames[0]?.actor ?? null);
    }
  }

  async #exitFrames(tid: number): Promise<Ref[]> {
    // Frames are already populated by EventFuture.finish -> #snapshotAll.
    // Return the outermost frame ref for this tid (innermost-first, index 0).
    const frames = this.#framesByTid.get(tid) ?? [];
    return frames.length ? [this.#frameRef(tid, 0)] : [];
  }

  #frameRef(tid: number, index: number): Ref {
    const id = this.#nextId++;
    this.#frameInfoById.set(id, { tid, index });
    return { $res: "Frame", id };
  }

  #parentFrame(id: number): Ref | null {
    const fi = this.#frameInfoById.get(id);
    if (!fi) return null;
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    if (fi.index + 1 >= frames.length) return null;
    return this.#frameRef(fi.tid, fi.index + 1);
  }

  #frameInstance(frameId: number): Ref {
    const fi = this.#frameInfoById.get(frameId)!;
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    const frame = frames[fi.index];
    const url =
      this.#sourceActorToUrl.get(frame?.where?.actor ?? "") ?? frame?.where?.actor ?? "";
    return this.#instanceRef(url);
  }

  #instanceRef(url: string): Ref {
    this.#moduleRef(url);
    const id = this.#nextId++;
    this.#instanceUrlById.set(id, url);
    return { $res: "Instance", id };
  }

  // --- locals / memory (evaluated in the stopped thread's wasm frame scope) ---
  async #localsForFrame(frameId: number): Promise<Ref[]> {
    const fi = this.#frameInfoById.get(frameId);
    if (!fi) return [];
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    const frame = frames[fi.index];
    if (!frame) return [];
    const env = (await this.#session.frameEnvironment(frame.actor)) as {
      bindings?: { variables?: Record<string, { value?: unknown }> };
    };
    const vars = env.bindings?.variables ?? {};
    return Object.keys(vars)
      .map((name) => ({ name, idx: /^var(\d+)$/.exec(name)?.[1] }))
      .filter((e): e is { name: string; idx: string } => e.idx !== undefined)
      .sort((a, b) => Number(a.idx) - Number(b.idx))
      .map((e) => this.#valueRef(vars[e.name].value));
  }

  async #readGlobal(index: number): Promise<Ref> {
    const vars = await this.#instanceScopeBindings();
    return this.#valueRef(vars[`global${index}`]?.value);
  }

  async #instanceScopeBindings(): Promise<Record<string, { value?: unknown }>> {
    // Use the stopped thread's top frame for global scope access.
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    if (!topActor) return {};
    let env = (await this.#session.frameEnvironment(topActor)) as
      | {
          scopeKind?: string;
          parent?: unknown;
          bindings?: { variables?: Record<string, { value?: unknown }> };
        }
      | undefined;
    while (env && env.scopeKind !== "wasm instance") {
      env = env.parent as typeof env;
    }
    return env?.bindings?.variables ?? {};
  }

  #valueRef(raw: unknown): Ref {
    let tag = "wasm-i32";
    let value: number | bigint = 0;
    if (typeof raw === "bigint") {
      tag = "wasm-i64";
      value = raw;
    } else if (typeof raw === "number") {
      value = raw;
      tag = Number.isInteger(raw) ? "wasm-i32" : "wasm-f64";
    }
    const id = this.#nextId++;
    this.#valueById.set(id, { tag, raw: value });
    return { $res: "WasmValue", id };
  }

  async #memorySize(): Promise<number> {
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    const consoleActor = this.#session.stoppedConsoleActor;
    if (!topActor || !consoleActor) return 0;
    try {
      const r = (await this.#session.evaluateInFrame(
        "memory0.buffer.byteLength",
        topActor,
        consoleActor,
      )) as { result?: unknown };
      return typeof r.result === "number" ? r.result : 0;
    } catch {
      return 0;
    }
  }

  async #readMemory(addr: number, len: number): Promise<Uint8Array> {
    const out = new Uint8Array(len);
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    const consoleActor = this.#session.stoppedConsoleActor;
    if (!topActor || !consoleActor) return out;
    const expr =
      `(()=>{const b=memory0.buffer,t=b.byteLength,a=${addr},n=${len},o=new Uint8Array(n);` +
      `if(a<t)o.set(new Uint8Array(b,a,Math.min(n,t-a)));` +
      `let s='';for(const x of o)s+=x.toString(16).padStart(2,'0');return s;})()`;
    try {
      const r = (await this.#session.evaluateInFrame(expr, topActor, consoleActor)) as {
        result?: unknown;
      };
      const hex = typeof r.result === "string" ? r.result : "";
      for (let i = 0; i < len && i * 2 + 1 < hex.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
    } catch {
      // evaluation timed out or failed — return zeros
    }
    return out;
  }

  // --- resumption ----------------------------------------------------------
  #armStopped(): void {
    this.#stopped = new Promise((resolve) => (this.#resolveStopped = resolve));
  }

  #eventFutureRef(): Ref {
    return { $res: "EventFuture", id: this.#nextId++ };
  }

  #eventTag(): string {
    switch (this.#lastPauseReason) {
      case "exception":
        return "trap";
      case "interrupted":
        return "interrupted";
      default:
        return "breakpoint";
    }
  }
}
