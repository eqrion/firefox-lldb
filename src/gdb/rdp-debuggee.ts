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
// Both wasm (`wasmcall`) and JS (`call`) RDP frames are surfaced so LLDB sees
// the real interleaved call stack. JS sources are represented as synthetic wasm
// modules carrying DWARF that maps DWARF address L -> source line L.
//
// WIT changes vs the single-thread version:
//   - Debuggee.listThreads  -> session.listTids()
//   - Debuggee.stoppedThread -> session.stoppedTid
//   - Debuggee.exitFrames(tid) -> per-tid snapshot
//   - Debuggee.singleStep(tid, resumption) -> session.stepOne(tid)
//   - Debuggee.continue     -> session.resumeAll()
//   - EventFuture.finish    -> awaits all-stop "stopped" event, then snapshots

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { RdpWasmSession, FrameForm, StoppedEvent } from "../rdp/session.js";
import { buildSyntheticModule } from "./synthetic-module.js";

function urlBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name) return name;
  } catch { /* fall through */ }
  return basename(url) || "source.js";
}

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

  // Synthetic modules for JS sources: url -> {bytecode, codeOffset}.
  #syntheticByUrl = new Map<string, { bytecode: Uint8Array; codeOffset: number }>();

  // Temp dir for materialized JS source text (for LLDB source list).
  #tmpDir: string = mkdtempSync(join(tmpdir(), "firefox-lldb-"));

  // Per-tid frame snapshots (innermost-first wasm+JS frames, set on each stop).
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

    session.on("stopped", (e: StoppedEvent) => {
      this.#lastPauseReason = (e.pausePacket as { why?: { type?: string } })?.why?.type ?? "breakpoint";
      this.#resolveStopped?.(e);
      this.#resolveStopped = null;
    });
    const tmpDir = this.#tmpDir;
    process.on("exit", () => {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
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
      case "Module.name": {
        const { url } = this.#moduleById.get(id)!;
        return urlBasename(url);
      }
      case "Module.bytecode": {
        const { url } = this.#moduleById.get(id)!;
        const syn = this.#syntheticByUrl.get(url);
        return syn ? syn.bytecode : this.#session.fetchModuleBytes(url);
      }
      case "Module.addBreakpoint": {
        const { url } = this.#moduleById.get(id)!;
        const syn = this.#syntheticByUrl.get(url);
        const pc = args[0] as number;
        if (syn) {
          await this.#session.setJsBreakpoint(url, pc - syn.codeOffset);
        } else {
          await this.#session.setWasmBreakpoint(url, pc);
        }
        return null;
      }
      case "Module.removeBreakpoint": {
        const { url } = this.#moduleById.get(id)!;
        const syn = this.#syntheticByUrl.get(url);
        const pc = args[0] as number;
        if (syn) {
          await this.#session.removeJsBreakpoint(url, pc - syn.codeOffset);
        } else {
          await this.#session.removeWasmBreakpoint(url, pc);
        }
        return null;
      }

      case "Instance.getModule":
        return this.#moduleRef(this.#instanceUrlById.get(id)!);
      case "Instance.uniqueId":
        return BigInt(this.#moduleByUrl.get(this.#instanceUrlById.get(id)!)!.id);
      case "Instance.getMemory": {
        const iUrl = this.#instanceUrlById.get(id)!;
        if (this.#syntheticByUrl.has(iUrl) || (args[0] as number) !== 0) {
          return Promise.reject(Object.assign(new Error("out-of-bounds"), { payload: "out-of-bounds" }));
        }
        return { $res: "Memory", id: this.#nextId++ };
      }
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
        const frame = this.#framesByTid.get(fi.tid)?.[fi.index];
        const line = frame?.where?.line ?? 0;
        if (frame?.type === "call") {
          const url = this.#sourceActorToUrl.get(frame.where!.actor) ?? frame.where!.actor;
          return line + (this.#syntheticByUrl.get(url)?.codeOffset ?? 0);
        }
        return line;
      }
      case "Frame.getLocals":
        return this.#localsForFrame(id);
      case "Frame.getStack":
        return [];
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
    const allSources = await this.#session.wasmSources();
    this.#sourceActorToUrl.clear();
    const refs: Ref[] = [];

    for (const s of allSources) {
      if (s.introductionType === "wasm") {
        this.#sourceActorToUrl.set(s.actor, s.url);
        refs.push(this.#moduleRef(s.url));
      } else {
        const key = s.url || s.actor;
        this.#sourceActorToUrl.set(s.actor, key);
        await this.#ensureSynthetic(key, s.actor);
        refs.push(this.#moduleRef(key));
      }
    }

    const jsSources = await this.#session.jsSources();
    for (const s of jsSources) {
      const key = s.url || s.actor;
      this.#sourceActorToUrl.set(s.actor, key);
      await this.#ensureSynthetic(key, s.actor);
      if (!this.#moduleByUrl.has(key)) refs.push(this.#moduleRef(key));
    }

    return refs;
  }

  async #ensureSynthetic(url: string, sourceActor: string): Promise<void> {
    if (this.#syntheticByUrl.has(url)) return;
    let text = "";
    try { text = await this.#session.fetchSourceText(sourceActor); } catch { /* skip */ }
    const lineCount = text ? text.split("\n").length : 1;
    const name = urlBasename(url);
    const filePath = join(this.#tmpDir, name);
    if (text) {
      try { writeFileSync(filePath, text, "utf8"); } catch { /* best-effort */ }
    }
    const compDir = dirname(filePath);
    const syn = buildSyntheticModule({ name, compDir, lineCount });
    this.#syntheticByUrl.set(url, syn);
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
    this.#frameInfoById.clear();
    const tids = this.#session.listTids();
    for (const tid of tids) {
      let frames: FrameForm[] = [];
      try {
        frames = (await this.#session.frames(tid)).filter(
          (f) => (f.type === "wasmcall" || f.type === "call") && f.where
        );
      } catch {
        frames = [];
      }
      this.#framesByTid.set(tid, frames);
      this.#topFrameActorByTid.set(
        tid,
        frames.find((f) => f.type === "wasmcall")?.actor ?? null
      );
    }
  }

  async #exitFrames(tid: number): Promise<Ref[]> {
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
    const url = this.#sourceActorToUrl.get(frame?.where?.actor ?? "") ?? frame?.where?.actor ?? "";
    return this.#instanceRef(url);
  }

  #instanceRef(url: string): Ref {
    this.#moduleRef(url);
    const id = this.#nextId++;
    this.#instanceUrlById.set(id, url);
    return { $res: "Instance", id };
  }

  // --- locals / memory -----------------------------------------------------
  async #localsForFrame(frameId: number): Promise<Ref[]> {
    const fi = this.#frameInfoById.get(frameId);
    if (!fi) return [];
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    const frame = frames[fi.index];
    if (!frame || frame.type === "call") return [];
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
