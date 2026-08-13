/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import { SourceDebuggerError, isSourceDebuggerError } from "../protocol/error.js";
import type { SourceDebuggerComponent, SourceDebuggerRun } from "../protocol/component.js";
import type {
  CommandResult,
  ComponentFrame,
  ComponentRunRequest,
  ComponentRunTermination,
  ComponentStop,
  ModuleDescriptor,
  PhysicalResumeRequest,
  SessionState,
  SessionThread,
  SourceBreakpoint,
  SourceBreakpointRequest,
  SourceDebuggerComponentDescriptor,
  SourceFile,
  SourceProperty,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "../protocol/types.js";

type RpcMethod = Exclude<keyof SourceDebuggerComponent, "id">;
type RunRpcMethod =
  | "$run-wait-for-stop"
  | "$run-wait-for-resume"
  | "$run-grant-resume"
  | "$run-rearm-observer"
  | "$run-terminate"
  | "$run-dispose";
type RpcCallMethod = RpcMethod | RunRpcMethod | "$hello";

interface RpcRequest {
  type: "source-debugger-request";
  id: number;
  method: RpcCallMethod;
  args: unknown[];
}

type ComponentRpcRequest = RpcRequest & { method: RpcMethod | RunRpcMethod | "$hello" };

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  sourceDebugger?: {
    code: SourceDebuggerError["code"];
    componentId?: string;
    operation?: string;
  };
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

interface RpcRunReference {
  resourceId: number;
  id: string;
  role: ComponentRunRequest["role"];
}

interface PendingCall {
  method: RpcCallMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const RPC_METHODS: RpcMethod[] = [
  "describe",
  "addModules",
  "removeModules",
  "sources",
  "sourceContent",
  "state",
  "threads",
  "frames",
  "scopes",
  "evaluate",
  "valueChildren",
  "setBreakpoint",
  "removeBreakpoint",
  "breakpoints",
  "beginRun",
  "command",
  "dispose",
];
const RUN_RPC_METHODS: RunRpcMethod[] = [
  "$run-wait-for-stop",
  "$run-wait-for-resume",
  "$run-grant-resume",
  "$run-rearm-observer",
  "$run-terminate",
  "$run-dispose",
];
const RPC_METHOD_SET = new Set<string>([...RPC_METHODS, ...RUN_RPC_METHODS]);

const REQUIRED_METHODS: RpcMethod[] = RPC_METHODS.filter((method) => method !== "command");

export interface SourceDebuggerRpcOptions {
  /** Reject a component call which does not settle within this deadline.
   * Long-running run waits and debugger-native command calls are exempt because
   * waiting is part of their contract. */
  requestTimeoutMs?: number;
  /** Called after a timeout or peer closure makes the entire RPC client
   * unusable. An isolation host can terminate the containing worker here. */
  onTransportFailure?: (error: SourceDebuggerError) => void;
}

export interface SourceDebuggerRpcEndpoint {
  close(): void;
}

export type RemoteSourceDebuggerComponent = SourceDebuggerComponent & SourceDebuggerRpcEndpoint;

export function serveSourceDebuggerComponent(
  port: MessagePort,
  component: SourceDebuggerComponent
): SourceDebuggerRpcEndpoint {
  const methods = RPC_METHODS.filter((method) => hasComponentMethod(component, method));
  const runs = new Map<number, SourceDebuggerRun>();
  let nextRunResourceId = 1;
  let closed = false;

  const onMessage = (message: unknown): void => {
    if (!isRequest(message)) return;
    void (async () => {
      try {
        let result: unknown;
        if (message.method === "$hello") {
          result = { id: component.id, methods } satisfies RpcHello;
        } else if (isRunRpcMethod(message.method)) {
          result = await callRunResource(runs, message.method, message.args);
        } else if (message.method === "beginRun") {
          const run = await component.beginRun(message.args[0] as ComponentRunRequest);
          const resourceId = nextRunResourceId++;
          runs.set(resourceId, run);
          result = { resourceId, id: run.id, role: run.role } satisfies RpcRunReference;
        } else {
          result = await componentMethod(component, message.method)(...message.args);
        }
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
      for (const run of runs.values()) void run.dispose().catch(() => {});
      runs.clear();
      port.off("message", onMessage);
      port.close();
    },
  };
}

export async function connectSourceDebuggerComponent(
  port: MessagePort,
  options: SourceDebuggerRpcOptions = {}
): Promise<RemoteSourceDebuggerComponent> {
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
    return new RemoteSourceDebuggerComponentProxy(client, hello);
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
    private readonly onTransportFailure?: (error: SourceDebuggerError) => void
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

  call<T>(method: RpcCallMethod, ...args: unknown[]): Promise<T> {
    if (this.#closed) {
      return Promise.reject(connectionError("SourceDebuggerComponent RPC is closed"));
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
            connectionError(
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
    this.#rejectPending(connectionError("SourceDebuggerComponent RPC closed"));
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
    this.#failTransport(connectionError("SourceDebuggerComponent RPC peer closed"));
  };

  #failTransport(error: SourceDebuggerError): void {
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

const NO_DEADLINE_METHODS = new Set<RpcCallMethod>([
  "$run-wait-for-stop",
  "$run-wait-for-resume",
  "command",
]);

class RemoteSourceDebuggerComponentProxy implements RemoteSourceDebuggerComponent {
  readonly id: string;
  readonly command?: (command: string) => Promise<CommandResult>;

  constructor(
    private readonly client: SourceDebuggerRpcClient,
    hello: RpcHello
  ) {
    this.id = hello.id;
    const methods = new Set(hello.methods);
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

  sourceContent(sourceId: string): Promise<string | null> {
    return this.client.call("sourceContent", sourceId);
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

  valueChildren(stopId: StopId, valueId: string): Promise<SourceProperty[]> {
    return this.client.call("valueChildren", stopId, valueId);
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

  async beginRun(request: ComponentRunRequest): Promise<SourceDebuggerRun> {
    const reference = await this.client.call<RpcRunReference>("beginRun", request);
    if (reference.id !== request.runId || reference.role !== request.role) {
      throw new Error(
        `SourceDebuggerComponent returned mismatched run ${reference.id}/${reference.role}`
      );
    }
    return new RemoteSourceDebuggerRun(this.client, reference);
  }

  async dispose(): Promise<void> {
    try {
      await this.client.call("dispose");
    } finally {
      this.client.close();
    }
  }

  close(): void {
    this.client.close();
  }
}

class RemoteSourceDebuggerRun implements SourceDebuggerRun {
  readonly id: string;
  readonly role: ComponentRunRequest["role"];
  readonly #resourceId: number;
  #disposed = false;

  constructor(
    private readonly client: SourceDebuggerRpcClient,
    reference: RpcRunReference
  ) {
    this.#resourceId = reference.resourceId;
    this.id = reference.id;
    this.role = reference.role;
  }

  waitForStop(): Promise<ComponentStop> {
    this.#requireOpen();
    return this.client.call("$run-wait-for-stop", this.#resourceId);
  }

  waitForResume(): Promise<PhysicalResumeRequest | undefined> {
    this.#requireOpen();
    return this.client.call("$run-wait-for-resume", this.#resourceId);
  }

  grantResume(request: PhysicalResumeRequest): Promise<void> {
    this.#requireOpen();
    return this.client.call("$run-grant-resume", this.#resourceId, request);
  }

  rearmObserver(): Promise<void> {
    this.#requireOpen();
    return this.client.call("$run-rearm-observer", this.#resourceId);
  }

  terminate(reason: ComponentRunTermination): Promise<void> {
    this.#requireOpen();
    return this.client.call("$run-terminate", this.#resourceId, reason);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.client.call("$run-dispose", this.#resourceId);
  }

  #requireOpen(): void {
    if (this.#disposed) throw new Error(`source debugger run ${this.id} is disposed`);
  }
}

async function callRunResource(
  runs: Map<number, SourceDebuggerRun>,
  method: RunRpcMethod,
  args: unknown[]
): Promise<unknown> {
  const resourceId = args[0];
  if (!Number.isInteger(resourceId)) throw new Error("invalid source debugger run resource id");
  const run = runs.get(resourceId as number);
  if (!run) throw new Error(`unknown source debugger run resource ${String(resourceId)}`);
  switch (method) {
    case "$run-wait-for-stop":
      return run.waitForStop();
    case "$run-wait-for-resume":
      return run.waitForResume();
    case "$run-grant-resume":
      return run.grantResume(args[1] as PhysicalResumeRequest);
    case "$run-rearm-observer":
      return run.rearmObserver();
    case "$run-terminate":
      return run.terminate(args[1] as ComponentRunTermination);
    case "$run-dispose":
      runs.delete(resourceId as number);
      return run.dispose();
  }
}

function isRunRpcMethod(method: RpcCallMethod): method is RunRpcMethod {
  return (RUN_RPC_METHODS as string[]).includes(method);
}

function componentMethod(
  component: SourceDebuggerComponent,
  method: RpcMethod
): (...args: unknown[]) => unknown {
  const value = (component as unknown as Record<RpcMethod, unknown>)[method];
  if (typeof value !== "function")
    throw new Error(`SourceDebuggerComponent does not export ${method}`);
  return value.bind(component) as (...args: unknown[]) => unknown;
}

function hasComponentMethod(component: SourceDebuggerComponent, method: RpcMethod): boolean {
  return typeof (component as unknown as Record<RpcMethod, unknown>)[method] === "function";
}

function isRequest(message: unknown): message is ComponentRpcRequest {
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
      ...(isSourceDebuggerError(error)
        ? {
            sourceDebugger: {
              code: error.code,
              ...(error.componentId ? { componentId: error.componentId } : {}),
              ...(error.operation ? { operation: error.operation } : {}),
            },
          }
        : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(error: SerializedError): Error {
  const result = error.sourceDebugger
    ? new SourceDebuggerError(error.sourceDebugger.code, error.message, {
        ...(error.sourceDebugger.componentId
          ? { componentId: error.sourceDebugger.componentId }
          : {}),
        ...(error.sourceDebugger.operation ? { operation: error.sourceDebugger.operation } : {}),
      })
    : new Error(error.message);
  if (!error.sourceDebugger) result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function connectionError(message: string): SourceDebuggerError {
  return new SourceDebuggerError("component-unavailable", message);
}
