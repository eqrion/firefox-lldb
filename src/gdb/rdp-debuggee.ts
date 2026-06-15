// Implements the gdbstub component's WIT `debuggee` interface (as dispatched
// over the worker SAB-RPC) on top of a live Firefox RDP session.
//
// The component is wasm-centric: exit-frames/parent-frame must yield WASM
// frames, and frame_to_pc requires each frame's instance/module/pc. We map:
//   - module      <-> a wasm source (stable id per URL); bytecode via HTTP fetch
//   - frame        <-> a `wasmcall` RDP frame (JS frames are skipped for now)
//   - frame.get-pc  =  RDP frame.where.line (the wasm byte offset)
//   - add-breakpoint = thread.setBreakpoint at {sourceUrl, line:offset, column:1}
//   - continue/step  = thread.resume; event-future.finish awaits the next pause
// Locals/globals/memory (instances, wasm-values) are deferred (M4).

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

  // Resolves on the next RDP pause (armed before resume/step/interrupt).
  #pause: Promise<void> = Promise.resolve();
  #resolvePause: (() => void) | null = null;
  #lastPauseReason = "breakpoint";

  constructor(session: RdpWasmSession) {
    this.#session = session;
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
        return []; // memories deferred (M4)
      case "Debuggee.exitFrames":
        return this.#exitFrames();
      case "Debuggee.continue":
        this.#armPause();
        this.#session.resume().catch(() => {});
        return this.#eventFutureRef();
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

      case "Frame.getInstance":
        return this.#frameInstance(id);
      case "Frame.getFuncIndex":
        return 0;
      case "Frame.getPc":
        return this.#frames[this.#frameIndexById.get(id)!].where!.line;
      case "Frame.getLocals":
        return []; // M4
      case "Frame.getStack":
        return []; // M5 (operand stack not exposed)
      case "Frame.parentFrame":
        return this.#parentFrame(id);

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
    // Ensure the module exists so getModule/uniqueId resolve.
    this.#moduleRef(url);
    const instId = this.#nextId++;
    this.#instanceUrlById.set(instId, url);
    return { $res: "Instance", id: instId };
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
