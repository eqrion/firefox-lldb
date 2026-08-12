/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import type { RdpDebuggeeResumeAction, RdpDebuggeeRunControl } from "../gdb/rdp-debuggee.js";
import { noopLogger, type Logger } from "../logging.js";
import type { GdbRspEndpoint, ModuleClaim, SourceDebuggerComponentInstance } from "./component.js";
import type {
  LldbIsolateControlMethod,
  LldbIsolateControlRequest,
  LldbIsolateControlResults,
  LldbIsolateHostMessage,
  LldbIsolateWorkerData,
} from "./lldb-isolate-protocol.js";
import { connectSourceDebuggerComponent } from "./rpc.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import { openTcpRspByteChannel, type HostRspByteChannel } from "./rsp-byte-channel.js";
import type { CommandResult, ModuleDescriptor } from "./types.js";

interface PendingControl {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface IsolatedLldbComponentRuntimeOptions {
  id?: string;
  name?: string;
  logger?: Logger;
  observerResumesTarget?: boolean;
  exclusiveModules?: boolean;
  verbose?: boolean;
  /** Deadline for bounded component RPC methods. Run waits and native commands
   * remain unbounded by contract. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

class IsolatedLldbRunControl implements RdpDebuggeeRunControl {
  readonly usesAbortSentinel: boolean;
  readonly #resumeCallbacks = new Map<number, (action: RdpDebuggeeResumeAction) => void>();
  #nextResumeId = 1;
  #synchronizeStop: ((tid?: number) => void) | undefined;
  #abortStop: ((tid?: number) => void) | undefined;

  constructor(
    private readonly send: (message: {
      type: "lldb-isolate-resume";
      id: number;
      action: RdpDebuggeeResumeAction;
    }) => void,
    usesAbortSentinel: boolean
  ) {
    this.usesAbortSentinel = usesAbortSentinel;
  }

  resume(
    action: RdpDebuggeeResumeAction,
    resumePhysicalTarget: (action: RdpDebuggeeResumeAction) => void
  ): void {
    const id = this.#nextResumeId++;
    this.#resumeCallbacks.set(id, resumePhysicalTarget);
    this.send({ type: "lldb-isolate-resume", id, action });
  }

  installSynchronizeStop(synchronize: (tid?: number) => void): void {
    this.#synchronizeStop = synchronize;
  }

  installAbortStop(abort: (tid?: number) => void): void {
    this.#abortStop = abort;
  }

  release(id: number, action: RdpDebuggeeResumeAction): void {
    const resume = this.#resumeCallbacks.get(id);
    if (!resume) return;
    this.#resumeCallbacks.delete(id);
    resume(action);
  }

  synchronizeStop(tid?: number): void {
    this.#synchronizeStop?.(tid);
  }

  abortStop(tid?: number): void {
    this.#abortStop?.(tid);
  }

  close(): void {
    // Dropping an unreleased lease is deliberately fail-closed: Firefox stays
    // paused while the component/session error propagates to the frontend.
    this.#resumeCallbacks.clear();
  }
}

export class IsolatedLldbComponentRuntime implements SourceDebuggerComponentProbe {
  readonly component: SourceDebuggerComponentInstance;
  readonly runControl: RdpDebuggeeRunControl;
  readonly #channel: LldbIsolateChannel;
  #closePromise: Promise<void> | undefined;

  private constructor(component: SourceDebuggerComponentInstance, channel: LldbIsolateChannel) {
    this.component = component;
    this.runControl = channel.runControl;
    this.#channel = channel;
  }

  get id(): string {
    return this.component.id;
  }

  static async create(
    options: IsolatedLldbComponentRuntimeOptions = {}
  ): Promise<IsolatedLldbComponentRuntime> {
    const componentChannel = new MessageChannel();
    const controlChannel = new MessageChannel();
    const logger = options.logger ?? noopLogger;
    const workerData: LldbIsolateWorkerData = {
      componentPort: componentChannel.port2,
      controlPort: controlChannel.port2,
      options: {
        id: options.id,
        name: options.name,
        observerResumesTarget: options.observerResumesTarget ?? true,
        exclusiveModules: options.exclusiveModules ?? false,
        verbose: options.verbose ?? false,
      },
    };
    const workerEntry = import.meta.url.endsWith(".ts")
      ? new URL("./lldb-isolate-worker-dev.mjs", import.meta.url)
      : new URL("./lldb-isolate-worker.js", import.meta.url);
    const worker = new Worker(workerEntry, {
      workerData,
      transferList: [componentChannel.port2, controlChannel.port2],
    });
    const channel = new LldbIsolateChannel(
      worker,
      controlChannel.port1,
      logger,
      options.exclusiveModules ?? false
    );
    try {
      await channel.ready;
      const component = await connectSourceDebuggerComponent(componentChannel.port1, {
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
        onTransportFailure: (error) => {
          logger.error(`[${options.id ?? "lldb"}] ${error.message}; terminating isolate`);
          void channel.terminate();
        },
      });
      return new IsolatedLldbComponentRuntime(component, channel);
    } catch (error) {
      componentChannel.port1.close();
      await channel.close().catch(() => {});
      throw error;
    }
  }

  readonly bridgeTcp = async (port: number): Promise<number> => {
    if (this.#closePromise) throw new Error(`LLDB component ${this.component.id} is closed`);
    const endpoint = this.#channel.registerRspEndpoint(port, "process");
    try {
      return await this.#channel.call("bridge-rsp", endpoint);
    } catch (error) {
      this.#channel.discardRspEndpoint(endpoint.id);
      throw error;
    }
  };

  async connectPlatform(port: number): Promise<void> {
    const endpoint = this.#channel.registerRspEndpoint(port, "platform");
    try {
      await this.#channel.call("connect-platform", endpoint);
    } catch (error) {
      this.#channel.discardRspEndpoint(endpoint.id);
      throw error;
    }
  }

  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return this.#channel.call("probe-module", module);
  }

  async attach(
    pid: number,
    options: { attempts?: number; onRetry?: (attempt: number) => void } = {}
  ): Promise<string> {
    const attempts = options.attempts ?? 4;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.#channel.call("attach", pid, 1);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          options.onRetry?.(attempt);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  command(command: string): Promise<CommandResult> {
    return this.#channel.call("command", command);
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#channel.close());
  }

  /** Force the isolation worker down. Normal cleanup uses close(); this is the
   * containment path for an unresponsive component. Its RPC peer immediately
   * rejects outstanding and subsequent calls when the port closes. */
  terminate(): Promise<void> {
    return (this.#closePromise ??= this.#channel.terminate());
  }
}

class LldbIsolateChannel {
  readonly ready: Promise<void>;
  readonly runControl: IsolatedLldbRunControl;
  readonly #pending = new Map<number, PendingControl>();
  readonly #rspEndpoints = new Map<string, { port: number; kind: GdbRspEndpoint["kind"] }>();
  readonly #rspChannels = new Set<HostRspByteChannel>();
  #nextId = 1;
  #nextRspEndpointId = 1;
  #closed = false;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;

  constructor(
    private readonly worker: Worker,
    private readonly port: MessagePort,
    private readonly logger: Logger,
    usesAbortSentinel: boolean
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.runControl = new IsolatedLldbRunControl(
      (message) => this.port.postMessage(message),
      usesAbortSentinel
    );
    port.on("message", this.#onMessage);
    port.on("close", this.#onPortClose);
    port.start();
    worker.on("error", this.#onWorkerError);
    worker.on("exit", this.#onWorkerExit);
  }

  registerRspEndpoint(port: number, kind: GdbRspEndpoint["kind"]): GdbRspEndpoint {
    if (this.#closed) throw new Error("LLDB component isolate is closed");
    const endpoint = { id: `rsp-${this.#nextRspEndpointId++}`, kind } satisfies GdbRspEndpoint;
    this.#rspEndpoints.set(endpoint.id, { port, kind });
    return endpoint;
  }

  discardRspEndpoint(id: string): void {
    this.#rspEndpoints.delete(id);
  }

  call<M extends LldbIsolateControlMethod>(
    method: M,
    ...args: unknown[]
  ): Promise<LldbIsolateControlResults[M]> {
    return this.#call(method, args);
  }

  #call<M extends LldbIsolateControlMethod>(
    method: M,
    args: unknown[]
  ): Promise<LldbIsolateControlResults[M]> {
    if (this.#closed) return Promise.reject(new Error("LLDB component isolate is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as LldbIsolateControlResults[M]),
        reject,
      });
      try {
        this.port.postMessage({
          type: "lldb-isolate-control-request",
          id,
          method,
          args,
        } satisfies LldbIsolateControlRequest);
      } catch (error) {
        this.#pending.delete(id);
        reject(toError(error));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.call("close").catch(() => {});
    this.#closeWithError(new Error("LLDB component isolate closed"));
    await this.worker.terminate();
  }

  async terminate(): Promise<void> {
    if (this.#closed) return;
    await this.worker.terminate();
    this.#closeWithError(new Error("LLDB component isolate terminated"));
  }

  #onMessage = (message: LldbIsolateHostMessage): void => {
    switch (message.type) {
      case "lldb-isolate-ready":
        this.#resolveReady();
        return;
      case "lldb-isolate-initialization-error":
        this.#rejectReady(deserializeError(message.error));
        return;
      case "lldb-isolate-control-response": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(deserializeError(message.error));
        else pending.resolve(message.result);
        return;
      }
      case "lldb-isolate-log":
        this.logger[message.level](message.message);
        return;
      case "lldb-isolate-release":
        this.runControl.release(message.id, message.action);
        return;
      case "lldb-isolate-synchronize-stop":
        this.runControl.synchronizeStop(message.tid);
        return;
      case "lldb-isolate-abort-stop":
        this.runControl.abortStop(message.tid);
        return;
      case "lldb-isolate-open-rsp":
        void this.#openRspEndpoint(message.id, message.endpoint).catch((error) =>
          this.#closeWithError(toError(error))
        );
        return;
    }
  };

  async #openRspEndpoint(requestId: number, endpoint: GdbRspEndpoint): Promise<void> {
    const registered = this.#rspEndpoints.get(endpoint.id);
    if (!registered || registered.kind !== endpoint.kind) {
      this.port.postMessage({
        type: "lldb-isolate-open-rsp-response",
        id: requestId,
        error: serializeError(new Error(`unknown ${endpoint.kind} RSP endpoint ${endpoint.id}`)),
      });
      return;
    }
    this.#rspEndpoints.delete(endpoint.id);

    let bridge: HostRspByteChannel | undefined;
    try {
      bridge = await openTcpRspByteChannel(registered.port, {
        logger: this.logger,
        label: `${endpoint.kind} ${endpoint.id}`,
      });
      if (this.#closed) throw new Error("LLDB component isolate closed while opening RSP");
      const liveBridge = bridge;
      this.#rspChannels.add(liveBridge);
      void liveBridge.closed.then(() => this.#rspChannels.delete(liveBridge));
      this.port.postMessage(
        {
          type: "lldb-isolate-open-rsp-response",
          id: requestId,
          port: bridge.componentPort,
        },
        [bridge.componentPort]
      );
    } catch (error) {
      bridge?.close();
      if (!this.#closed) {
        this.port.postMessage({
          type: "lldb-isolate-open-rsp-response",
          id: requestId,
          error: serializeError(error),
        });
      }
    }
  }

  #onPortClose = (): void => {
    this.#closeWithError(new Error("LLDB component isolate control port closed"));
  };

  #onWorkerError = (error: Error): void => {
    this.#closeWithError(error);
  };

  #onWorkerExit = (code: number): void => {
    this.#closeWithError(new Error(`LLDB component isolate exited with code ${code}`));
  };

  #closeWithError(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#rspEndpoints.clear();
    for (const bridge of this.#rspChannels) bridge.close();
    this.#rspChannels.clear();
    this.runControl.close();
    this.port.off("message", this.#onMessage);
    this.port.off("close", this.#onPortClose);
    this.port.close();
  }
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(error: { name: string; message: string; stack?: string }): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
