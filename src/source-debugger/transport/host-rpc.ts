/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import type {
  GdbRspConnection,
  GdbRspEndpoint,
  SourceDebuggerComponentHost,
} from "../protocol/component.js";
import type { SourceDebuggerComponentHostBinding } from "../target/host.js";
import type { WasmDebuggee, WasmDebuggeeResumeAction } from "../protocol/wasm-debuggee.js";
import { connectRspByteChannel } from "./rsp-byte-channel.js";
import type { SourceDebuggerRpcEndpoint } from "./rpc.js";

type HostMethod = "connect-gdb-rsp" | "open-wasm-debuggee" | "wasm-debuggee-call";
type WasmDebuggeeMethod = keyof WasmDebuggee;

interface HostRequest {
  type: "source-debugger-host-request";
  id: number;
  method: HostMethod;
  args: unknown[];
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface HostResponse {
  type: "source-debugger-host-response";
  id: number;
  result?: unknown;
  port?: MessagePort;
  error?: SerializedError;
}

interface PendingHostCall {
  method: HostMethod;
  resolve: (result: HostResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export type RemoteSourceDebuggerComponentHost = SourceDebuggerComponentHost &
  SourceDebuggerRpcEndpoint;

/** Serve component imports on the host side. Imported objects are represented
 * as RPC resources, matching the ownership model intended for future WIT
 * resources without exposing MessagePort or Firefox objects to a component. */
export function serveSourceDebuggerComponentHost(
  port: MessagePort,
  host: SourceDebuggerComponentHostBinding
): SourceDebuggerRpcEndpoint {
  const debuggees = new Map<number, WasmDebuggee>();
  let nextDebuggeeId = 1;
  let closed = false;

  const onMessage = (message: unknown): void => {
    if (!isRequest(message)) return;
    void (async () => {
      try {
        let result: unknown;
        let responsePort: MessagePort | undefined;
        switch (message.method) {
          case "connect-gdb-rsp": {
            const channel = await host.openGdbRspChannel(message.args[0] as GdbRspEndpoint);
            if (closed) {
              channel.close();
              return;
            }
            responsePort = channel.componentPort;
            break;
          }
          case "open-wasm-debuggee": {
            const debuggee = await host.openWasmDebuggee();
            const resourceId = nextDebuggeeId++;
            debuggees.set(resourceId, debuggee);
            result = resourceId;
            break;
          }
          case "wasm-debuggee-call": {
            const resourceId = message.args[0] as number;
            const method = message.args[1] as WasmDebuggeeMethod;
            const args = message.args[2] as unknown[];
            const debuggee = debuggees.get(resourceId);
            if (!debuggee) throw new Error(`unknown Wasm debuggee resource ${resourceId}`);
            result = await debuggeeMethod(debuggee, method)(...args);
            if (method === "dispose") debuggees.delete(resourceId);
            break;
          }
        }
        if (closed) {
          responsePort?.close();
          return;
        }
        const response = {
          type: "source-debugger-host-response",
          id: message.id,
          ...(result === undefined ? {} : { result }),
          ...(responsePort ? { port: responsePort } : {}),
        } satisfies HostResponse;
        port.postMessage(response, responsePort ? [responsePort] : []);
      } catch (error) {
        try {
          if (!closed) {
            port.postMessage({
              type: "source-debugger-host-response",
              id: message.id,
              error: serializeError(error),
            } satisfies HostResponse);
          }
        } catch {
          // The isolate closed while an imported capability call was settling.
        }
      }
    })();
  };
  port.on("message", onMessage);
  port.start();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      for (const debuggee of debuggees.values()) void debuggee.dispose().catch(() => {});
      debuggees.clear();
      port.off("message", onMessage);
      port.close();
    },
  };
}

export function connectSourceDebuggerComponentHost(
  port: MessagePort,
  options: { requestTimeoutMs?: number } = {}
): RemoteSourceDebuggerComponentHost {
  const timeoutMs = options.requestTimeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("SourceDebuggerComponent host RPC timeout must be a positive number");
  }
  const pending = new Map<number, PendingHostCall>();
  let nextId = 1;
  let closed = false;

  const rejectPending = (error: Error): void => {
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };
  const close = (error = new Error("SourceDebuggerComponent host RPC closed")): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    port.off("close", onClose);
    port.close();
    rejectPending(error);
  };
  const onMessage = (message: unknown): void => {
    if (!isResponse(message)) return;
    const call = pending.get(message.id);
    if (!call) {
      message.port?.close();
      return;
    }
    pending.delete(message.id);
    if (call.timer) clearTimeout(call.timer);
    if (message.error) {
      message.port?.close();
      call.reject(deserializeError(message.error));
    } else {
      call.resolve(message);
    }
  };
  const onClose = (): void => close(new Error("SourceDebuggerComponent host RPC peer closed"));
  port.on("message", onMessage);
  port.on("close", onClose);
  port.start();

  const call = (
    method: HostMethod,
    args: unknown[],
    options: { noDeadline?: boolean } = {}
  ): Promise<HostResponse> => {
    if (closed) return Promise.reject(new Error("SourceDebuggerComponent host RPC is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const pendingCall: PendingHostCall = { method, resolve, reject };
      if (timeoutMs !== undefined && !options.noDeadline) {
        pendingCall.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(
            new Error(`SourceDebuggerComponent host RPC ${method} timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }
      pending.set(id, pendingCall);
      try {
        port.postMessage({
          type: "source-debugger-host-request",
          id,
          method,
          args,
        } satisfies HostRequest);
      } catch (error) {
        pending.delete(id);
        if (pendingCall.timer) clearTimeout(pendingCall.timer);
        reject(toError(error));
      }
    });
  };

  return {
    async connectGdbRsp(endpoint: GdbRspEndpoint): Promise<GdbRspConnection> {
      const response = await call("connect-gdb-rsp", [endpoint]);
      if (!response.port) {
        throw new Error("SourceDebuggerComponent host returned no GDB RSP connection");
      }
      return connectRspByteChannel(response.port);
    },
    async openWasmDebuggee(): Promise<WasmDebuggee> {
      const response = await call("open-wasm-debuggee", []);
      if (typeof response.result !== "number") {
        throw new Error("SourceDebuggerComponent host returned no Wasm debuggee resource");
      }
      return remoteWasmDebuggee(response.result, call);
    },
    close: () => close(),
  };
}

function remoteWasmDebuggee(
  resourceId: number,
  call: (
    method: HostMethod,
    args: unknown[],
    options?: { noDeadline?: boolean }
  ) => Promise<HostResponse>
): WasmDebuggee {
  const invoke = async <T>(
    method: WasmDebuggeeMethod,
    args: unknown[] = [],
    options?: { noDeadline?: boolean }
  ): Promise<T> =>
    (await call("wasm-debuggee-call", [resourceId, method, args], options)).result as T;
  return {
    modules: () => invoke("modules"),
    moduleBytecode: (moduleId) => invoke("moduleBytecode", [moduleId]),
    breakpointOffsets: (moduleId) => invoke("breakpointOffsets", [moduleId]),
    threads: () => invoke("threads"),
    frames: (threadId) => invoke("frames", [threadId]),
    frameVariables: (frameId) => invoke("frameVariables", [frameId]),
    addBreakpoint: (moduleId, offset) => invoke("addBreakpoint", [moduleId, offset]),
    removeBreakpoint: (moduleId, offset) => invoke("removeBreakpoint", [moduleId, offset]),
    waitForStop: () => invoke("waitForStop", [], { noDeadline: true }),
    cancelWaitForStop: () => invoke("cancelWaitForStop"),
    resume: (action: WasmDebuggeeResumeAction) => invoke("resume", [action]),
    interrupt: () => invoke("interrupt"),
    dispose: () => invoke("dispose"),
  };
}

function debuggeeMethod(
  debuggee: WasmDebuggee,
  method: WasmDebuggeeMethod
): (...args: unknown[]) => unknown {
  const value = (debuggee as unknown as Record<WasmDebuggeeMethod, unknown>)[method];
  if (typeof value !== "function") throw new Error(`Wasm debuggee does not export ${method}`);
  return value.bind(debuggee) as (...args: unknown[]) => unknown;
}

function isRequest(message: unknown): message is HostRequest {
  if (!message || typeof message !== "object") return false;
  const request = message as Partial<HostRequest>;
  return (
    request.type === "source-debugger-host-request" &&
    typeof request.id === "number" &&
    (request.method === "connect-gdb-rsp" ||
      request.method === "open-wasm-debuggee" ||
      request.method === "wasm-debuggee-call") &&
    Array.isArray(request.args)
  );
}

function isResponse(message: unknown): message is HostResponse {
  if (!message || typeof message !== "object") return false;
  const response = message as Partial<HostResponse>;
  return response.type === "source-debugger-host-response" && typeof response.id === "number";
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(error: SerializedError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
