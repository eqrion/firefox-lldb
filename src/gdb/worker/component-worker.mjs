/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs inside a Node Worker. Instantiates the (sync) gdbstub component and
// implements the `debuggee` interface as thin proxies that perform a SYNCHRONOUS
// RPC to the main thread for every call. The worker blocks on Atomics.wait
// while the main thread services the request asynchronously (RDP), so the
// component sees a synchronous debuggee while the main event loop stays free.

import { parentPort, workerData } from "node:worker_threads";
import { parseResponse, isRecord } from "./contract.mjs";
/** @import * as Wit from "../generated/interfaces/bytecodealliance-wasmtime-debuggee.js" */
if (!parentPort) throw new Error("gdb component must run in a worker");
const portToHost = parentPort;
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { instantiate } from "../generated/gdbstub.js";
import {
  encode,
  decode,
  CTRL_STATE,
  CTRL_LEN,
  STATE_IDLE,
  STATE_REQUEST,
  STATE_RESPONSE,
} from "./wire.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(here, "../generated");

const ctrl = new Int32Array(workerData.sab, 0, 4);
const data = new Uint8Array(workerData.sab, 16);
let nextSequence = 1;

// Synchronous RPC: write request, signal main, block until the response lands.
/** @template T
 * @param {string} type @param {number} id @param {string} method
 * @param {unknown[]} args @returns {T} */
function rpc(type, id, method, args) {
  const sequence = nextSequence++;
  const operation = `${type}.${method}#${sequence}`;
  const msg = encode({ sequence, type, id, method, args });
  if (msg.length > data.length) {
    throw Object.assign(new Error("out-of-bounds"), { payload: "out-of-bounds" });
  }
  data.set(msg, 0);
  Atomics.store(ctrl, CTRL_LEN, msg.length);
  Atomics.store(ctrl, CTRL_STATE, STATE_REQUEST);
  portToHost.postMessage(1);
  let waitResult;
  while (Atomics.load(ctrl, CTRL_STATE) === STATE_REQUEST) {
    waitResult = Atomics.wait(ctrl, CTRL_STATE, STATE_REQUEST);
  }
  const state = Atomics.load(ctrl, CTRL_STATE);
  const len = Atomics.load(ctrl, CTRL_LEN);
  let resp;
  try {
    if (len < 0 || len > data.length || state !== STATE_RESPONSE)
      throw new Error("invalid gdb response state/length");
    resp = parseResponse(decode(data.subarray(0, len)), sequence);
  } catch (cause) {
    throw new Error(
      `could not decode gdb RPC response for ${operation} ` +
        `(wait=${waitResult ?? "not-waited"}, state=${state}, len=${len})`,
      { cause }
    );
  }
  Atomics.store(ctrl, CTRL_STATE, STATE_IDLE);
  if (!resp.ok) {
    const err = new Error(
      `${operation}: ${resp.error.kind === "modeled" ? resp.error.tag : resp.error.message}`
    );
    if (resp.error.kind === "modeled") throw Object.assign(err, { payload: resp.error.tag });
    throw err;
  }
  return /** @type {T} */ (wrap(resp.value));
}

/** @param {unknown} value @returns {unknown} */
function wrap(value) {
  if (Array.isArray(value)) return value.map(wrap);
  if (isRecord(value) && "$res" in value) return makeProxy(value);
  return value;
}

/** @type {Map<string, number>} */
const resourceReferences = new Map();
const symbolDispose = Symbol.dispose || Symbol.for("dispose");

/** Imported resources own their host handle until the final clone is dropped. */
class Resource {
  /** @param {string} type @param {number} id */
  constructor(type, id) {
    this.__id = id;
    this.__type = type;
    this.__released = false;
    const key = `${type}:${id}`;
    resourceReferences.set(key, (resourceReferences.get(key) ?? 0) + 1);
  }

  [symbolDispose]() {
    if (this.__released) return;
    this.__released = true;
    const key = `${this.__type}:${this.__id}`;
    const remaining = resourceReferences.get(key);
    if (remaining === undefined) throw new Error("unowned gdb resource drop");
    if (remaining > 1) resourceReferences.set(key, remaining - 1);
    else {
      resourceReferences.delete(key);
      rpc(this.__type, this.__id, "drop", []);
    }
  }
}

/** @param {Record<string, unknown>} ref @returns {Resource} */
function makeProxy(ref) {
  if (
    typeof ref.$res !== "string" ||
    !Object.hasOwn(CLASSES, ref.$res) ||
    typeof ref.id !== "number" ||
    !Number.isSafeInteger(ref.id) ||
    ref.id < 0
  )
    throw new Error("invalid debugger resource reference");
  const Cls = CLASSES[/** @type {keyof typeof CLASSES} */ (ref.$res)];
  return new Cls(ref.$res, ref.id);
}

// Drop the borrow<debuggee> argument the component threads through most methods.
/** @param {unknown} a */
const isDebuggee = (a) => a instanceof Debuggee;
/** @param {unknown[]} args */
const restArgs = (args) => args.filter((a) => !isDebuggee(a));

/** @implements {Wit.Debuggee} */
class Debuggee {
  /** @returns {Module[]} */
  allModules() {
    return rpc("Debuggee", 0, "allModules", []);
  }
  /** @returns {Instance[]} */
  allInstances() {
    return rpc("Debuggee", 0, "allInstances", []);
  }
  listThreads() {
    return Uint32Array.from(/** @type {number[]} */ (rpc("Debuggee", 0, "listThreads", [])));
  }
  /** @returns {number} */
  stoppedThread() {
    return rpc("Debuggee", 0, "stoppedThread", []);
  }
  /** @param {number} tid @returns {Frame[]} */
  exitFrames(tid) {
    return rpc("Debuggee", 0, "exitFrames", [tid]);
  }
  /** @param {Wit.ResumptionValue} rv @returns {EventFuture} */
  continue(rv) {
    return rpc("Debuggee", 0, "continue", [rv]);
  }
  /** @param {number} tid @param {Wit.ResumptionValue} rv @returns {EventFuture} */
  singleStep(tid, rv) {
    return rpc("Debuggee", 0, "singleStep", [tid, rv]);
  }
}
class EventFuture extends Resource {
  /** @param {EventFuture} self @param {Debuggee} _d @returns {Wit.Event} */
  static finish(self, _d) {
    return rpc("EventFuture", self.__id, "finish", []);
  }
}
/** @implements {Wit.Module} */
class Module extends Resource {
  /** @returns {Uint8Array | undefined} */
  bytecode() {
    return rpc("Module", this.__id, "bytecode", []);
  }
  /** @returns {bigint} */
  uniqueId() {
    return rpc("Module", this.__id, "uniqueId", []);
  }
  /** @param {...unknown} a @returns {number} */
  addBreakpoint(...a) {
    return rpc("Module", this.__id, "addBreakpoint", restArgs(a));
  }
  /** @param {...unknown} a @returns {void} */
  removeBreakpoint(...a) {
    return rpc("Module", this.__id, "removeBreakpoint", restArgs(a));
  }
  /** @returns {string} */
  name() {
    return rpc("Module", this.__id, "name", []);
  }
  /** @returns {Module} */
  clone() {
    return /** @type {Module} */ (makeProxy({ $res: "Module", id: this.__id }));
  }
}
/** @implements {Wit.Instance} */
class Instance extends Resource {
  /** @param {...unknown} a @returns {Module} */
  getModule(...a) {
    return rpc("Instance", this.__id, "getModule", restArgs(a));
  }
  /** @param {...unknown} a @returns {Memory} */
  getMemory(...a) {
    return rpc("Instance", this.__id, "getMemory", restArgs(a));
  }
  /** @param {...unknown} a @returns {Global} */
  getGlobal(...a) {
    return rpc("Instance", this.__id, "getGlobal", restArgs(a));
  }
  /** @returns {bigint} */
  uniqueId() {
    return rpc("Instance", this.__id, "uniqueId", []);
  }
  /** @returns {Instance} */
  clone() {
    return /** @type {Instance} */ (makeProxy({ $res: "Instance", id: this.__id }));
  }
}
/** @implements {Wit.Memory} */
class Memory extends Resource {
  /** @param {...unknown} a @returns {bigint} */
  sizeBytes(...a) {
    return rpc("Memory", this.__id, "sizeBytes", restArgs(a));
  }
  /** @param {...unknown} a @returns {Uint8Array} */
  getBytes(...a) {
    return rpc("Memory", this.__id, "getBytes", restArgs(a));
  }
  /** @returns {bigint} */
  uniqueId() {
    return rpc("Memory", this.__id, "uniqueId", []);
  }
  /** @returns {Memory} */
  clone() {
    return /** @type {Memory} */ (makeProxy({ $res: "Memory", id: this.__id }));
  }
}
/** @implements {Wit.Global} */
class Global extends Resource {
  /** @param {...unknown} a @returns {WasmValue} */
  get(...a) {
    return rpc("Global", this.__id, "get", restArgs(a));
  }
}
/** @implements {Wit.Frame} */
class Frame extends Resource {
  /** @param {...unknown} a @returns {Instance} */
  getInstance(...a) {
    return rpc("Frame", this.__id, "getInstance", restArgs(a));
  }
  /** @param {...unknown} a @returns {number} */
  getPc(...a) {
    return rpc("Frame", this.__id, "getPc", restArgs(a));
  }
  /** @param {...unknown} a @returns {WasmValue} */
  getLocal(...a) {
    return rpc("Frame", this.__id, "getLocal", restArgs(a));
  }
  /** @param {...unknown} a @returns {WasmValue[]} */
  getStack(...a) {
    return rpc("Frame", this.__id, "getStack", restArgs(a));
  }
  /** @param {...unknown} a @returns {Frame | undefined} */
  parentFrame(...a) {
    return rpc("Frame", this.__id, "parentFrame", restArgs(a));
  }
}
/** @implements {Wit.WasmValue} */
class WasmValue extends Resource {
  /** @returns {Wit.WasmType} */
  getType() {
    return rpc("WasmValue", this.__id, "getType", []);
  }
  /** @returns {number} */
  unwrapI32() {
    return rpc("WasmValue", this.__id, "unwrapI32", []);
  }
  /** @returns {bigint} */
  unwrapI64() {
    return rpc("WasmValue", this.__id, "unwrapI64", []);
  }
  /** @returns {number} */
  unwrapF32() {
    return rpc("WasmValue", this.__id, "unwrapF32", []);
  }
  /** @returns {number} */
  unwrapF64() {
    return rpc("WasmValue", this.__id, "unwrapF64", []);
  }
  /** @returns {Uint8Array} */
  unwrapV128() {
    return rpc("WasmValue", this.__id, "unwrapV128", []);
  }
  /** @returns {WasmValue} */
  clone() {
    return rpc("WasmValue", this.__id, "clone", []);
  }
}
/** @implements {Wit.WasmFunc} */
class WasmFunc extends Resource {}
/** @implements {Wit.WasmException} */
class WasmException extends Resource {}

const CLASSES = {
  EventFuture,
  Module,
  Instance,
  Memory,
  Global,
  Frame,
  WasmValue,
  WasmFunc,
  WasmException,
};

/** @param {string} message */
function boundedTrace(message) {
  return message.length <= 4096
    ? message
    : `${message.slice(0, 4096)}… [${message.length - 4096} chars omitted]`;
}

const imports = {
  ...new WASIShim().getImportObject(),
  "print-debugger-info": {
    default: /** @param {string} m */ (m) => portToHost.postMessage({ info: boundedTrace(m) }),
  },
  "debugger-listening": {
    default: /** @param {number} port */ (port) => portToHost.postMessage({ listening: port }),
  },
  "log-line": {
    default: /** @param {string} m */ (m) => portToHost.postMessage({ trace: boundedTrace(m) }),
  },
  "bytecodealliance:wasmtime/debuggee": { Debuggee, ...CLASSES },
};

// jco/WASI accepts unversioned import keys at runtime; its declaration requires
// versioned keys. Resource methods above are checked against the emitted WIT types.
/** @typedef {(getModule: (path: string) => Promise<object>, imports: object) => Promise<{debugger: {debug(d: Debuggee, args: string[]): void}}>} InstantiateFn */
const instantiateComponent = /** @type {InstantiateFn} */ (/** @type {unknown} */ (instantiate));
const wasm = /** @type {{WebAssembly: {compile(bytes: Uint8Array): Promise<object>}}} */ (
  /** @type {unknown} */ (globalThis)
).WebAssembly;
const root = await instantiateComponent(
  async (corePath) => wasm.compile(await readFile(path.join(GEN, corePath))),
  imports
);
const dbg = root.debugger;

const debugArgs = ["gdbstub", `127.0.0.1:${workerData.port}`];
if (workerData.verbose) debugArgs.push("-v");
dbg.debug(new Debuggee(), debugArgs);
portToHost.postMessage({ done: true });
