/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** @typedef {import('../generated/interfaces/bytecodealliance-wasmtime-debuggee.js').Error} WitError */
/** @typedef {{sequence: number, type: string, id: number, method: string, args: unknown[]}} RpcRequest */
/** @typedef {{kind: 'modeled', tag: WitError} | {kind: 'fatal', message: string}} RpcError */
/** @typedef {{ok: true, sequence: number, value: unknown} | {ok: false, sequence: number, error: RpcError}} RpcResponse */

/** @type {ReadonlySet<WitError>} */
const errors = new Set([
  "invalid-entity",
  "invalid-pc",
  "invalid-frame",
  "unsupported-type",
  "mismatched-type",
  "non-wasm-frame",
  "alloc-failure",
  "breakpoint-update",
  "read-only",
  "out-of-bounds",
  "memory-grow-failure",
  "execution-trap",
]);

/** @param {unknown} value @returns {value is WitError} */
function isWitError(value) {
  return typeof value === "string" && errors.has(/** @type {WitError} */ (value));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
const u32 = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
/** @param {unknown} value */
const u64 = (value) => typeof value === "bigint" && value >= 0n && value <= 0xffffffffffffffffn;
/** @param {unknown} value */
const normal = (value) => isRecord(value) && value.tag === "normal" && value.val === undefined;
/** @type {Readonly<Record<string, readonly ((value: unknown) => boolean)[]>>} */
const argumentsByMethod = {
  "Debuggee.allModules": [],
  "Debuggee.allInstances": [],
  "Debuggee.listThreads": [],
  "Debuggee.stoppedThread": [],
  "Debuggee.exitFrames": [u32],
  "Debuggee.continue": [normal],
  "Debuggee.singleStep": [u32, normal],
  "EventFuture.finish": [],
  "Module.bytecode": [],
  "Module.uniqueId": [],
  "Module.name": [],
  "Module.addBreakpoint": [u32],
  "Module.removeBreakpoint": [u32],
  "Instance.getModule": [],
  "Instance.getMemory": [u32],
  "Instance.getGlobal": [u32],
  "Instance.uniqueId": [],
  "Global.get": [],
  "Memory.sizeBytes": [],
  "Memory.getBytes": [u64, u64],
  "Memory.uniqueId": [],
  "Frame.getInstance": [],
  "Frame.getPc": [],
  "Frame.getLocal": [u32],
  "Frame.getStack": [],
  "Frame.parentFrame": [],
  "WasmValue.getType": [],
  "WasmValue.unwrapI32": [],
  "WasmValue.unwrapI64": [],
  "WasmValue.unwrapF32": [],
  "WasmValue.unwrapF64": [],
  "WasmValue.unwrapV128": [],
  "WasmValue.clone": [],
};
const resources = new Set([
  "EventFuture",
  "Module",
  "Instance",
  "Memory",
  "Global",
  "Frame",
  "WasmValue",
  "WasmFunc",
  "WasmException",
]);

/** @param {unknown} value @returns {RpcRequest} */
export function parseRequest(value) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.type !== "string" ||
    value.type.length > 64 ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 0 ||
    typeof value.method !== "string" ||
    value.method.length > 64 ||
    !Array.isArray(value.args)
  )
    throw new Error("invalid gdb RPC request");
  const request = /** @type {RpcRequest} */ (value);
  const key = `${request.type}.${request.method}`;
  const validators =
    request.method === "drop" && resources.has(request.type)
      ? []
      : Object.hasOwn(argumentsByMethod, key)
        ? argumentsByMethod[key]
        : undefined;
  if (
    !validators ||
    request.args.length !== validators.length ||
    !validators.every((validate, index) => validate(request.args[index])) ||
    (request.type === "Debuggee" ? request.id !== 0 : request.id === 0)
  )
    throw new Error(`invalid gdb RPC method or arguments: ${key}`);
  return request;
}

/** Unexpected exceptions must never become valid-looking WIT error variants.
 * @param {unknown} error @returns {RpcError} */
export function wireError(error) {
  if (isRecord(error) && isWitError(error.payload)) return { kind: "modeled", tag: error.payload };
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "fatal", message: message.slice(0, 4096) };
}

/** @param {unknown} value @param {number} sequence @returns {RpcResponse} */
export function parseResponse(value, sequence) {
  if (!isRecord(value) || value.sequence !== sequence || typeof value.ok !== "boolean")
    throw new Error(`invalid gdb RPC response sequence ${sequence}`);
  if (value.ok) return { ok: true, sequence, value: value.value };
  if (isRecord(value.error)) {
    if (value.error.kind === "modeled" && isWitError(value.error.tag))
      return { ok: false, sequence, error: { kind: "modeled", tag: value.error.tag } };
    if (
      value.error.kind === "fatal" &&
      typeof value.error.message === "string" &&
      value.error.message.length <= 4096
    )
      return { ok: false, sequence, error: { kind: "fatal", message: value.error.message } };
  }
  throw new Error("invalid gdb RPC error envelope");
}
