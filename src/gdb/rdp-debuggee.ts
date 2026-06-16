// Implements the gdbstub component's WIT `debuggee` interface (as dispatched
// over the worker SAB-RPC) on top of a live Firefox RDP session.
//
// The component is wasm-centric: exit-frames/parent-frame must yield WASM
// frames, and frame_to_pc requires each frame's instance/module/pc. We map:
//   - module      <-> a wasm source (stable id per URL); bytecode via HTTP fetch
//   - frame        <-> a `wasmcall` RDP frame (JS frames are skipped; wasm-centric)
//   - frame.get-pc  =  RDP frame.where.line (the wasm byte offset)
//   - add-breakpoint = thread.setBreakpoint at {sourceUrl, line:offset, column:1}
//   - continue/step  = thread.resume; event-future.finish awaits the next pause
// Locals/globals/memory (instances, wasm-values) are exposed via the env chain.

import type { RdpWasmSession, FrameForm } from "../rdp/session.js";

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

  // Per-stop frame snapshot (innermost-first wasm frames).
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
      case "Module.bytecode":
        return this.#session.fetchModuleBytes(this.#moduleById.get(id)!.url);
      case "Module.addBreakpoint":
        await this.#session.setWasmBreakpoint(this.#moduleById.get(id)!.url, args[0] as number);
        return null;
      case "Module.removeBreakpoint":
        await this.#session.removeWasmBreakpoint(this.#moduleById.get(id)!.url, args[0] as number);
        return null;

      case "Instance.getModule":
        return this.#moduleRef(this.#instanceUrlById.get(id)!);
      case "Instance.uniqueId":
        return BigInt(this.#moduleByUrl.get(this.#instanceUrlById.get(id)!)!.id);
      case "Instance.getMemory":
        // Single linear memory (index 0) per instance.
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
      case "Frame.getPc":
        return this.#frames[this.#frameIndexById.get(id)!].where!.line;
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

  // --- frames --------------------------------------------------------------
  async #snapshot(): Promise<void> {
    let frames: FrameForm[] = [];
    try {
      frames = (await this.#session.frames()).filter((f) => f.type === "wasmcall" && f.where);
    } catch {
      frames = []; // not paused
    }
    this.#frames = frames;
    this.#frameIndexById.clear();
    this.#topFrameActor = frames[0]?.actor ?? null;
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
