// A deterministic in-memory debuggee for TDD: serves a fixed wasm module, call
// stack, locals, and linear memory so lldb's wasm client can be driven against
// our real gdbstub component without a live Firefox. Modeled on the data in
// LLVM's lldb/test/.../TestWasm.py.
//
// Implements the same RPC dispatch surface as RdpDebuggee (see rdp-debuggee.ts),
// so it plugs into the same worker host.

import type { RpcRequest } from "./rdp-debuggee.js";

export interface FakeConfig {
  /** Module bytecode (a real .wasm with DWARF so lldb can symbolicate). */
  bytecode: Uint8Array;
  /** Call stack as wasm byte offsets, innermost first. */
  callStack: number[];
  /** Locals per frame index: frameLocals[frame][localIndex] = i32 value. */
  frameLocals?: number[][];
  /** Linear memory: base address + bytes (for shadow-stack locals). */
  memory?: { base: number; bytes: Uint8Array };
}

type Ref = { $res: string; id: number };
const i32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
};

export class FakeDebuggee {
  #cfg: FakeConfig;
  #nextId = 1;
  #frameIndexById = new Map<number, number>();
  #valueById = new Map<number, Uint8Array>();

  constructor(cfg: FakeConfig) {
    this.#cfg = cfg;
  }

  async dispatch(req: RpcRequest): Promise<unknown> {
    const { type, id, method, args } = req;
    const key = `${type}.${method}`;
    switch (key) {
      case "Debuggee.allModules":
        return [{ $res: "Module", id: 1 }];
      case "Debuggee.allInstances":
        return this.#cfg.memory ? [{ $res: "Instance", id: 2 }] : [];
      case "Debuggee.exitFrames":
        this.#frameIndexById.clear();
        return this.#cfg.callStack.length ? [this.#frameRef(0)] : [];
      case "Debuggee.continue":
      case "Debuggee.singleStep":
        return { $res: "EventFuture", id: this.#nextId++ };
      case "Debuggee.interrupt":
        return null;
      case "EventFuture.finish":
        // The fake never resumes to a new state; report a breakpoint.
        return { tag: "breakpoint" };

      case "Module.uniqueId":
        return 1n;
      case "Module.bytecode":
        return this.#cfg.bytecode;
      case "Module.addBreakpoint":
      case "Module.removeBreakpoint":
        return null;

      case "Instance.getModule":
        return { $res: "Module", id: 1 };
      case "Instance.uniqueId":
        return 1n;
      case "Instance.getMemory":
        return (args[0] as number) === 0 && this.#cfg.memory
          ? { $res: "Memory", id: 3 }
          : Promise.reject(new Error("out-of-bounds"));

      case "Memory.sizeBytes":
        return BigInt(this.#cfg.memory ? this.#cfg.memory.bytes.length : 0);
      case "Memory.getBytes": {
        const addr = Number(args[0] as bigint);
        const len = Number(args[1] as bigint);
        const m = this.#cfg.memory!;
        const off = addr - m.base;
        if (off < 0 || off + len > m.bytes.length) throw new Error("out-of-bounds");
        return m.bytes.subarray(off, off + len);
      }

      case "Frame.getInstance":
        return { $res: "Instance", id: 2 };
      case "Frame.getFuncIndex":
        return 0;
      case "Frame.getPc":
        return this.#cfg.callStack[this.#frameIndexById.get(id)!];
      case "Frame.getLocals":
        return this.#localsFor(this.#frameIndexById.get(id)!);
      case "Frame.getStack":
        return [];
      case "Frame.parentFrame": {
        const i = this.#frameIndexById.get(id)!;
        return i + 1 < this.#cfg.callStack.length ? this.#frameRef(i + 1) : null;
      }

      case "WasmValue.getType":
        return { tag: "wasm-i32" };
      case "WasmValue.unwrapI32":
        return new DataView(this.#valueById.get(id)!.buffer).getUint32(0, true);
      case "WasmValue.clone": {
        const newId = this.#nextId++;
        this.#valueById.set(newId, this.#valueById.get(id)!);
        return { $res: "WasmValue", id: newId };
      }

      default:
        throw new Error(`FakeDebuggee: unhandled ${key}`);
    }
  }

  #frameRef(index: number): Ref {
    const id = this.#nextId++;
    this.#frameIndexById.set(id, index);
    return { $res: "Frame", id };
  }

  #localsFor(frameIndex: number): Ref[] {
    const locals = this.#cfg.frameLocals?.[frameIndex] ?? [];
    return locals.map((v) => {
      const id = this.#nextId++;
      this.#valueById.set(id, i32(v));
      return { $res: "WasmValue", id };
    });
  }
}
