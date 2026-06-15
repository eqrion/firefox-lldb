// Runs inside a Node Worker. Instantiates the (sync) gdbstub component and
// implements the `debuggee` interface as thin proxies that perform a SYNCHRONOUS
// RPC to the main thread for every call. The worker blocks on Atomics.wait
// while the main thread services the request asynchronously (RDP), so the
// component sees a synchronous debuggee while the main event loop stays free.

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { instantiate } from "../generated/gdbstub.js";
import { encode, decode, CTRL_STATE, CTRL_LEN, STATE_IDLE, STATE_REQUEST } from "./wire.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(here, "../generated");

const ctrl = new Int32Array(workerData.sab, 0, 4);
const data = new Uint8Array(workerData.sab, 16);

// Synchronous RPC: write request, signal main, block until the response lands.
function rpc(type, id, method, args) {
  const msg = encode({ type, id, method, args });
  data.set(msg, 0);
  Atomics.store(ctrl, CTRL_LEN, msg.length);
  Atomics.store(ctrl, CTRL_STATE, STATE_REQUEST);
  parentPort.postMessage(1);
  Atomics.wait(ctrl, CTRL_STATE, STATE_REQUEST);
  const len = Atomics.load(ctrl, CTRL_LEN);
  const resp = decode(data.subarray(0, len));
  Atomics.store(ctrl, CTRL_STATE, STATE_IDLE);
  if (!resp.ok) {
    // jco lifts a thrown error into a WIT `result` Err only via `.payload`
    // (which must be the error enum's tag, e.g. "out-of-bounds"); a bare Error
    // is re-thrown. Attach payload so debuggee methods can signal Err.
    const err = new Error(resp.error || "rpc error");
    err.payload = resp.error;
    throw err;
  }
  return wrap(resp.value);
}

// Recursively turn {$res} refs in a decoded value into live class instances.
function wrap(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(wrap);
  if (v.$res) return makeProxy(v);
  return v;
}

function makeProxy(ref) {
  const Cls = CLASSES[ref.$res];
  const o = Object.create(Cls.prototype);
  o.__id = ref.id;
  return o;
}

// Drop the borrow<debuggee> argument the component threads through most methods.
const isDebuggee = (a) => a instanceof Debuggee;
const restArgs = (args) => args.filter((a) => !isDebuggee(a));

class Debuggee {
  allModules() { return rpc("Debuggee", 0, "allModules", []); }
  allInstances() { return rpc("Debuggee", 0, "allInstances", []); }
  exitFrames() { return rpc("Debuggee", 0, "exitFrames", []); }
  continue(rv) { return rpc("Debuggee", 0, "continue", [rv]); }
  singleStep(rv) { return rpc("Debuggee", 0, "singleStep", [rv]); }
  interrupt() { return rpc("Debuggee", 0, "interrupt", []); }
}
class EventFuture {
  subscribe() { return { ready: () => true, block: () => {} }; }
  static finish(self, _d) { return rpc("EventFuture", self.__id, "finish", []); }
}
class Module {
  bytecode() { return rpc("Module", this.__id, "bytecode", []); }
  uniqueId() { return rpc("Module", this.__id, "uniqueId", []); }
  addBreakpoint(...a) { return rpc("Module", this.__id, "addBreakpoint", restArgs(a)); }
  removeBreakpoint(...a) { return rpc("Module", this.__id, "removeBreakpoint", restArgs(a)); }
  clone() { return makeProxy({ $res: "Module", id: this.__id }); }
}
class Instance {
  getModule(...a) { return rpc("Instance", this.__id, "getModule", restArgs(a)); }
  getMemory(...a) { return rpc("Instance", this.__id, "getMemory", restArgs(a)); }
  getGlobal(...a) { return rpc("Instance", this.__id, "getGlobal", restArgs(a)); }
  uniqueId() { return rpc("Instance", this.__id, "uniqueId", []); }
  clone() { return makeProxy({ $res: "Instance", id: this.__id }); }
}
class Memory {
  sizeBytes(...a) { return rpc("Memory", this.__id, "sizeBytes", restArgs(a)); }
  getBytes(...a) { return rpc("Memory", this.__id, "getBytes", restArgs(a)); }
  uniqueId() { return rpc("Memory", this.__id, "uniqueId", []); }
  clone() { return makeProxy({ $res: "Memory", id: this.__id }); }
}
class Global {
  get(...a) { return rpc("Global", this.__id, "get", restArgs(a)); }
}
class Frame {
  getInstance(...a) { return rpc("Frame", this.__id, "getInstance", restArgs(a)); }
  getFuncIndex(...a) { return rpc("Frame", this.__id, "getFuncIndex", restArgs(a)); }
  getPc(...a) { return rpc("Frame", this.__id, "getPc", restArgs(a)); }
  getLocals(...a) { return rpc("Frame", this.__id, "getLocals", restArgs(a)); }
  getStack(...a) { return rpc("Frame", this.__id, "getStack", restArgs(a)); }
  parentFrame(...a) { return rpc("Frame", this.__id, "parentFrame", restArgs(a)); }
}
class WasmValue {
  getType() { return rpc("WasmValue", this.__id, "getType", []); }
  unwrapI32() { return rpc("WasmValue", this.__id, "unwrapI32", []); }
  unwrapI64() { return rpc("WasmValue", this.__id, "unwrapI64", []); }
  unwrapF32() { return rpc("WasmValue", this.__id, "unwrapF32", []); }
  unwrapF64() { return rpc("WasmValue", this.__id, "unwrapF64", []); }
  unwrapV128() { return rpc("WasmValue", this.__id, "unwrapV128", []); }
  clone() { return rpc("WasmValue", this.__id, "clone", []); }
}
class Table {}
class WasmFunc {}
class WasmException {}
class WasmTag {}

const CLASSES = {
  Debuggee, EventFuture, Module, Instance, Memory, Global, Frame,
  WasmValue, Table, WasmFunc, WasmException, WasmTag,
};

const imports = {
  ...new WASIShim().getImportObject(),
  "print-debugger-info": { default: (m) => parentPort.postMessage({ info: m }) },
  "bytecodealliance:wasmtime/debuggee": CLASSES,
};

const root = await instantiate(
  async (corePath) => WebAssembly.compile(await readFile(path.join(GEN, corePath))),
  imports
);
const dbg = root["debugger"] ?? root["bytecodealliance:wasmtime/debugger@44.0.0"];

parentPort.postMessage({ ready: true });
const debugArgs = ["gdbstub", `127.0.0.1:${workerData.port}`];
if (workerData.verbose) debugArgs.push("-v");
dbg.debug(new Debuggee(), debugArgs);
parentPort.postMessage({ done: true });
