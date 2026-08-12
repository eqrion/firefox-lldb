/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import type { SourceDebuggerComponentInstance } from "./component.js";
import type {
  CommandResult,
  ComponentFrame,
  ComponentRunRequest,
  ComponentStop,
  ModuleDescriptor,
  RunId,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SourceBreakpointRequest,
  SourceDebuggerComponentDescriptor,
  SourceFile,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "./types.js";

type RpcMethod = Exclude<keyof SourceDebuggerComponentInstance, "id">;

export type SourceDebuggerRpcTransportFailure = "closed" | "peer-closed" | "timeout";

export class SourceDebuggerRpcTransportError extends Error {
  constructor(
    readonly failure: SourceDebuggerRpcTransportFailure,
    message: string
  ) {
    super(message);
    this.name = "SourceDebuggerRpcTransportError";
  }
}

export function isSourceDebuggerRpcTransportError(
  error: unknown
): error is SourceDebuggerRpcTransportError {
  return error instanceof SourceDebuggerRpcTransportError;
}

interface RpcRequest {
  type: "source-debugger-request";
  id: number;
  method: RpcMethod | "$hello";
  args: unknown[];
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface RpcResponse {
  type: "source-debugger-response";
  id: number;
  result?: unknown;
  error?: SerializedError;
}

interface RpcHello {
  id: string;
  methods: RpcMethod[];
}

interface PendingCall {
  method: RpcMethod | "$hello";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const RPC_METHODS: RpcMethod[] = [
  "describe",
  "addModules",
  "removeModules",
  "sources",
  "state",
  "threads",
  "frames",
  "scopes",
  "evaluate",
  "setBreakpoint",
  "removeBreakpoint",
  "breakpoints",
  "startRun",
  "waitForStop",
  "waitForPhysicalResume",
  "releasePhysicalResume",
  "synchronizeRun",
  "abortRun",
  "cancelRun",
  "command",
  "dispose",
];
const RPC_METHOD_SET = new Set<string>(RPC_METHODS);

const REQUIRED_METHODS: RpcMethod[] = RPC_METHODS.filter(
  (method) =>
    ![
      "waitForPhysicalResume",
      "releasePhysicalResume",
      "synchronizeRun",
      "abortRun",
      "command",
    ].includes(method)
);

export interface SourceDebuggerRpcOptions {
  /** Reject a component call which does not settle within this deadline.
   * Long-running waitForStop, waitForPhysicalResume, and debugger-native
   * command calls are exempt because waiting is part of their contract. */
  requestTimeoutMs?: number;
  /** Called after a timeout or peer closure makes the entire RPC client
   * unusable. An isolation host can terminate the containing worker here. */
  onTransportFailure?: (error: SourceDebuggerRpcTransportError) => void;
}

export interface SourceDebuggerRpcEndpoint {
  close(): void;
}

export function serveSourceDebuggerComponent(
  port: MessagePort,
  component: SourceDebuggerComponentInstance
): SourceDebuggerRpcEndpoint {
  const methods = RPC_METHODS.filter((method) => hasComponentMethod(component, method));
  let closed = false;

  const onMessage = (message: unknown): void => {
    if (!isRequest(message)) return;
    void (async () => {
      try {
        const result =
          message.method === "$hello"
            ? ({ id: component.id, methods } satisfies RpcHello)
            : await componentMethod(component, message.method)(...message.args);
        if (!closed) {
          port.postMessage({ type: "source-debugger-response", id: message.id, result });
        }
      } catch (error) {
        try {
          if (!closed) {
            port.postMessage({
              type: "source-debugger-response",
              id: message.id,
              error: serializeError(error),
            });
          }
        } catch {
          // The peer closed while an asynchronous component call was settling.
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
      port.off("message", onMessage);
      port.close();
    },
  };
}

export async function connectSourceDebuggerComponent(
  port: MessagePort,
  options: SourceDebuggerRpcOptions = {}
): Promise<SourceDebuggerComponentInstance> {
  const client = new SourceDebuggerRpcClient(
    port,
    options.requestTimeoutMs,
    options.onTransportFailure
  );
  try {
    const hello = await client.call<RpcHello>("$hello");
    for (const method of REQUIRED_METHODS) {
      if (!hello.methods.includes(method)) {
        throw new Error(`SourceDebuggerComponent ${hello.id} does not export ${method}`);
      }
    }
    return new RemoteSourceDebuggerComponent(client, hello);
  } catch (error) {
    client.close();
    throw error;
  }
}

class SourceDebuggerRpcClient {
  readonly #pending = new Map<number, PendingCall>();
  readonly #timeoutMs: number | undefined;
  #nextId = 1;
  #closed = false;

  constructor(
    private readonly port: MessagePort,
    requestTimeoutMs?: number,
    private readonly onTransportFailure?: (error: SourceDebuggerRpcTransportError) => void
  ) {
    if (
      requestTimeoutMs !== undefined &&
      (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
    ) {
      throw new Error("SourceDebuggerComponent RPC timeout must be a positive number");
    }
    this.#timeoutMs = requestTimeoutMs;
    port.on("message", this.#onMessage);
    port.on("close", this.#onClose);
    port.start();
  }

  call<T>(method: RpcMethod | "$hello", ...args: unknown[]): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new SourceDebuggerRpcTransportError("closed", "SourceDebuggerComponent RPC is closed")
      );
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (this.#timeoutMs !== undefined && !NO_DEADLINE_METHODS.has(method)) {
        pending.timer = setTimeout(() => {
          if (!this.#pending.has(id)) return;
          this.#failTransport(
            new SourceDebuggerRpcTransportError(
              "timeout",
              `SourceDebuggerComponent RPC ${String(method)} timed out after ${this.#timeoutMs}ms`
            )
          );
        }, this.#timeoutMs);
      }
      this.#pending.set(id, pending);
      try {
        this.port.postMessage({
          type: "source-debugger-request",
          id,
          method,
          args,
        } satisfies RpcRequest);
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.port.off("message", this.#onMessage);
    this.port.off("close", this.#onClose);
    this.port.close();
    this.#rejectPending(
      new SourceDebuggerRpcTransportError("closed", "SourceDebuggerComponent RPC closed")
    );
  }

  #onMessage = (message: unknown): void => {
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(deserializeError(message.error));
    else pending.resolve(message.result);
  };

  #onClose = (): void => {
    this.#failTransport(
      new SourceDebuggerRpcTransportError("peer-closed", "SourceDebuggerComponent RPC peer closed")
    );
  };

  #failTransport(error: SourceDebuggerRpcTransportError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.port.off("message", this.#onMessage);
    this.port.off("close", this.#onClose);
    this.port.close();
    this.#rejectPending(error);
    this.onTransportFailure?.(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const NO_DEADLINE_METHODS = new Set<RpcMethod | "$hello">([
  "waitForStop",
  "waitForPhysicalResume",
  "command",
]);

class RemoteSourceDebuggerComponent implements SourceDebuggerComponentInstance {
  readonly id: string;
  readonly waitForPhysicalResume?: (
    runId: RunId,
    afterSequence: number
  ) => Promise<number | undefined>;
  readonly releasePhysicalResume?: (runId: RunId, sequence: number) => Promise<void>;
  readonly synchronizeRun?: (runId: RunId) => Promise<void>;
  readonly abortRun?: (runId: RunId) => Promise<void>;
  readonly command?: (command: string) => Promise<CommandResult>;

  constructor(
    private readonly client: SourceDebuggerRpcClient,
    hello: RpcHello
  ) {
    this.id = hello.id;
    const methods = new Set(hello.methods);
    if (methods.has("waitForPhysicalResume")) {
      this.waitForPhysicalResume = (runId, afterSequence) =>
        this.client.call("waitForPhysicalResume", runId, afterSequence);
    }
    if (methods.has("releasePhysicalResume")) {
      this.releasePhysicalResume = (runId, sequence) =>
        this.client.call("releasePhysicalResume", runId, sequence);
    }
    if (methods.has("synchronizeRun")) {
      this.synchronizeRun = (runId) => this.client.call("synchronizeRun", runId);
    }
    if (methods.has("abortRun")) {
      this.abortRun = (runId) => this.client.call("abortRun", runId);
    }
    if (methods.has("command")) {
      this.command = (command) => this.client.call("command", command);
    }
  }

  describe(): Promise<SourceDebuggerComponentDescriptor> {
    return this.client.call("describe");
  }

  addModules(modules: ModuleDescriptor[], initialStop: StopId): Promise<void> {
    return this.client.call("addModules", modules, initialStop);
  }

  removeModules(moduleIds: string[]): Promise<void> {
    return this.client.call("removeModules", moduleIds);
  }

  sources(moduleId?: string): Promise<SourceFile[]> {
    return this.client.call("sources", moduleId);
  }

  state(stopId: StopId): Promise<SessionState> {
    return this.client.call("state", stopId);
  }

  threads(stopId: StopId): Promise<SessionThread[]> {
    return this.client.call("threads", stopId);
  }

  frames(stopId: StopId, threadId: ThreadId): Promise<ComponentFrame[]> {
    return this.client.call("frames", stopId, threadId);
  }

  scopes(stopId: StopId, frameId: string): Promise<SourceScope[]> {
    return this.client.call("scopes", stopId, frameId);
  }

  evaluate(stopId: StopId, frameId: string, expression: string): Promise<SourceValue | null> {
    return this.client.call("evaluate", stopId, frameId, expression);
  }

  setBreakpoint(request: SourceBreakpointRequest): Promise<SourceBreakpoint> {
    return this.client.call("setBreakpoint", request);
  }

  removeBreakpoint(id: string): Promise<void> {
    return this.client.call("removeBreakpoint", id);
  }

  breakpoints(): Promise<SourceBreakpoint[]> {
    return this.client.call("breakpoints");
  }

  startRun(request: ComponentRunRequest): Promise<void> {
    return this.client.call("startRun", request);
  }

  waitForStop(runId: RunId): Promise<ComponentStop> {
    return this.client.call("waitForStop", runId);
  }

  cancelRun(runId: RunId): Promise<void> {
    return this.client.call("cancelRun", runId);
  }

  async dispose(): Promise<void> {
    try {
      await this.client.call("dispose");
    } finally {
      this.client.close();
    }
  }
}

function componentMethod(
  component: SourceDebuggerComponentInstance,
  method: RpcMethod
): (...args: unknown[]) => unknown {
  const value = (component as unknown as Record<RpcMethod, unknown>)[method];
  if (typeof value !== "function")
    throw new Error(`SourceDebuggerComponent does not export ${method}`);
  return value.bind(component) as (...args: unknown[]) => unknown;
}

function hasComponentMethod(
  component: SourceDebuggerComponentInstance,
  method: RpcMethod
): boolean {
  return typeof (component as unknown as Record<RpcMethod, unknown>)[method] === "function";
}

function isRequest(message: unknown): message is RpcRequest {
  if (!message || typeof message !== "object") return false;
  const request = message as Partial<RpcRequest>;
  return (
    request.type === "source-debugger-request" &&
    typeof request.id === "number" &&
    (request.method === "$hello" ||
      (typeof request.method === "string" && RPC_METHOD_SET.has(request.method))) &&
    Array.isArray(request.args)
  );
}

function isResponse(message: unknown): message is RpcResponse {
  if (!message || typeof message !== "object") return false;
  const response = message as Partial<RpcResponse>;
  return response.type === "source-debugger-response" && typeof response.id === "number";
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
