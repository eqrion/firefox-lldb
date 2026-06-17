/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Implements the gdbstub component's WIT `debuggee` interface (as dispatched
// over the worker SAB-RPC) on top of a live Firefox RDP session.
//
// Both wasm (`wasmcall`) and JS (`call`) RDP frames are surfaced so LLDB sees
// the real interleaved call stack. JS sources are represented as synthetic wasm
// modules carrying DWARF that maps DWARF address L -> source line L. JS frames
// report pc = where.line + codeOffset so LLDB's subtraction of the code
// section offset recovers the DWARF address (= the source line).
//   - module     <-> a wasm source (real bytes via HTTP) or a JS source (synthetic)
//   - frame      <-> a `wasmcall` or `call` RDP frame (both surfaced)
//   - frame.getPc = where.line (wasm) or where.line + codeOffset (JS)
//   - addBreakpoint = setWasmBreakpoint (wasm) or setJsBreakpoint (JS, no snapping)
//   - continue/step = thread.resume; event-future.finish awaits the next pause
// Locals/globals/memory are exposed via the env chain (wasm frames only for now).

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { RdpWasmSession, FrameForm } from "../rdp/session.js";
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

  // Per-stop frame snapshot (innermost-first, wasm+JS frames).
  #frames: FrameForm[] = [];
  #frameIndexById = new Map<number, number>();

  // Instance refs (id -> module URL).
  #instanceUrlById = new Map<number, string>();

  // WasmValue refs (id -> {tag, raw}); raw is the JS value from RDP bindings.
  #valueById = new Map<number, { tag: string; raw: number | bigint }>();

  // Global refs (id -> global index in the instance's global index space).
  #globalIndexById = new Map<number, number>();

  // The innermost wasm frame actor of the current pause; memory reads and
  // local lookups evaluate in this frame's scope (where `memory0` is visible).
  #topFrameActor: string | null = null;

  // Resolves on the next RDP pause (armed before resume/step/interrupt).
  #pause: Promise<void> = Promise.resolve();
  #resolvePause: (() => void) | null = null;
  #lastPauseReason = "breakpoint";

  // Fired once, on LLDB's first continue (used by the live bridge to drive the
  // page's wasm export only after a breakpoint is armed and execution resumes,
  // so the engine pauses inside wasm rather than running the call to completion).
  #onFirstContinue: (() => void) | null = null;

  constructor(session: RdpWasmSession, opts?: { onFirstContinue?: () => void }) {
    this.#session = session;
    this.#onFirstContinue = opts?.onFirstContinue ?? null;
    session.on("paused", (p: { why?: { type?: string } }) => {
      this.#lastPauseReason = p?.why?.type ?? "breakpoint";
      this.#resolvePause?.();
      this.#resolvePause = null;
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
      case "Debuggee.exitFrames":
        return this.#exitFrames();
      case "Debuggee.continue": {
        this.#armPause();
        this.#session.resume().catch(() => {});
        const cb = this.#onFirstContinue;
        this.#onFirstContinue = null;
        cb?.();
        return this.#eventFutureRef();
      }
      case "Debuggee.singleStep":
        this.#armPause();
        this.#session.step().catch(() => {});
        return this.#eventFutureRef();
      case "Debuggee.interrupt":
        this.#armPause();
        this.#session.interrupt().catch(() => {});
        return null;
      case "EventFuture.finish":
        await this.#pause;
        await this.#snapshot();
        return { tag: this.#eventTag() };

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
        const frame = this.#frames[this.#frameIndexById.get(id)!];
        const line = frame.where!.line;
        if (frame.type === "call") {
          // JS frame: add codeOffset so LLDB can subtract it to recover the DWARF address.
          const url = this.#sourceActorToUrl.get(frame.where!.actor) ?? frame.where!.actor;
          return line + (this.#syntheticByUrl.get(url)?.codeOffset ?? 0);
        }
        return line;
      }
      case "Frame.getLocals":
        return this.#frames[this.#frameIndexById.get(id)!]?.type === "call"
          ? [] // JS locals not yet supported
          : this.#localsForFrame(id);
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
    const allSources = await this.#session.sources();
    this.#sourceActorToUrl.clear();
    const refs: Ref[] = [];

    for (const s of allSources) {
      if (s.introductionType === "wasm") {
        // Real wasm module: track actor -> url, register as real module.
        this.#sourceActorToUrl.set(s.actor, s.url);
        refs.push(this.#moduleRef(s.url));
        // Keep the wasm actor cache in session in sync.
        this.#session.cacheWasmActor(s.actor, s.url);
      } else {
        // JS source: use url if present, else fall back to actor id so that
        // every frame's source actor is guaranteed to be in #sourceActorToUrl.
        const key = s.url || s.actor;
        this.#sourceActorToUrl.set(s.actor, key);
        await this.#ensureSynthetic(key, s.actor);
        refs.push(this.#moduleRef(key));
      }
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

  // --- frames --------------------------------------------------------------
  async #snapshot(): Promise<void> {
    let frames: FrameForm[] = [];
    try {
      frames = (await this.#session.frames()).filter(
        (f) => (f.type === "wasmcall" || f.type === "call") && f.where,
      );
    } catch {
      frames = []; // not paused
    }
    this.#frames = frames;
    this.#frameIndexById.clear();
    // topFrameActor is the innermost *wasm* frame for memory/globals access.
    this.#topFrameActor = frames.find((f) => f.type === "wasmcall")?.actor ?? null;
  }

  async #exitFrames(): Promise<Ref[]> {
    await this.#snapshot();
    return this.#frames.length ? [this.#frameRef(0)] : [];
  }

  #frameRef(index: number): Ref {
    const id = this.#nextId++;
    this.#frameIndexById.set(id, index);
    return { $res: "Frame", id };
  }

  #parentFrame(id: number): Ref | null {
    const i = this.#frameIndexById.get(id);
    if (i === undefined || i + 1 >= this.#frames.length) return null;
    return this.#frameRef(i + 1);
  }

  #frameInstance(frameId: number): Ref {
    const frame = this.#frames[this.#frameIndexById.get(frameId)!];
    const url = this.#sourceActorToUrl.get(frame.where!.actor) ?? frame.where!.actor;
    return this.#instanceRef(url);
  }

  #instanceRef(url: string): Ref {
    // Ensure the module exists so getModule/uniqueId resolve.
    this.#moduleRef(url);
    const id = this.#nextId++;
    this.#instanceUrlById.set(id, url);
    return { $res: "Instance", id };
  }

  async #allInstances(): Promise<Ref[]> {
    const sources = await this.#session.wasmSources();
    return sources.length ? [this.#instanceRef(sources[0].url)] : [];
  }

  // --- locals / memory (evaluated in the innermost wasm frame's scope) -------
  async #localsForFrame(frameId: number): Promise<Ref[]> {
    const frame = this.#frames[this.#frameIndexById.get(frameId)!];
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

  // The wasm-instance scope (parent of the frame's function scope) holds
  // `global0..globalN` and `memory0`.
  async #instanceScopeBindings(): Promise<Record<string, { value?: unknown }>> {
    if (!this.#topFrameActor) return {};
    let env = (await this.#session.frameEnvironment(this.#topFrameActor)) as
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

  // RDP reports local/global values as plain JS values without an explicit wasm
  // type. Infer: bigint -> i64, non-integer number -> f64, else i32. (i32 is
  // what lldb needs for the frame-base/shadow-stack pointer.)
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
    if (!this.#topFrameActor) return 0;
    const r = (await this.#session.evaluateInFrame(
      "memory0.buffer.byteLength",
      this.#topFrameActor
    )) as { result?: unknown };
    return typeof r.result === "number" ? r.result : 0;
  }

  async #readMemory(addr: number, len: number): Promise<Uint8Array> {
    const out = new Uint8Array(len);
    if (!this.#topFrameActor) return out;
    const expr =
      `(()=>{const b=memory0.buffer,t=b.byteLength,a=${addr},n=${len},o=new Uint8Array(n);` +
      `if(a<t)o.set(new Uint8Array(b,a,Math.min(n,t-a)));` +
      `let s='';for(const x of o)s+=x.toString(16).padStart(2,'0');return s;})()`;
    const r = (await this.#session.evaluateInFrame(expr, this.#topFrameActor)) as {
      result?: unknown;
    };
    const hex = typeof r.result === "string" ? r.result : "";
    for (let i = 0; i < len && i * 2 + 1 < hex.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  // --- resumption ----------------------------------------------------------
  #armPause(): void {
    this.#pause = new Promise((resolve) => (this.#resolvePause = resolve));
  }

  #eventFutureRef(): Ref {
    return { $res: "EventFuture", id: this.#nextId++ };
  }

  #eventTag(): string {
    // RDP "why" types -> debuggee event variants. Most stops are breakpoints.
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
