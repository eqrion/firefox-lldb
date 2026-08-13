/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { noopLogger, type Logger } from "../../../logging.js";
import type {
  ModuleClaim,
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
} from "../../protocol/component.js";
import { SourceDebuggerComponentIsolate } from "../../transport/isolate.js";
import type {
  LldbIsolateControlMethod,
  LldbIsolateControlRequest,
  LldbIsolateControlResults,
  LldbIsolateHostMessage,
  LldbIsolateWorkerData,
} from "./isolate-protocol.js";
import type { SourceDebuggerComponentProbe } from "../../session/ownership.js";
import type { CommandResult, ModuleDescriptor } from "../../protocol/types.js";

interface PendingControl {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface IsolatedLldbComponentRuntimeOptions {
  host: SourceDebuggerComponentHost;
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

export class IsolatedLldbComponentRuntime implements SourceDebuggerComponentProbe {
  readonly #isolate: SourceDebuggerComponentIsolate;
  readonly #channel: LldbIsolateChannel;
  #closePromise: Promise<void> | undefined;

  private constructor(isolate: SourceDebuggerComponentIsolate, channel: LldbIsolateChannel) {
    this.#isolate = isolate;
    this.#channel = channel;
  }

  get id(): string {
    return this.#isolate.id;
  }

  get definition(): SourceDebuggerComponentIsolate["definition"] {
    return this.#isolate.definition;
  }

  get component(): SourceDebuggerComponent {
    return this.#isolate.component;
  }

  static async create(
    options: IsolatedLldbComponentRuntimeOptions
  ): Promise<IsolatedLldbComponentRuntime> {
    const controlChannel = new MessageChannel();
    const logger = options.logger ?? noopLogger;
    let channel: LldbIsolateChannel | undefined;
    const componentId = options.id ?? "lldb";
    const isolate = new SourceDebuggerComponentIsolate(componentId, options.host, {
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      onTransportFailure: (error) => {
        logger.error(`[${componentId}] ${error.message}; terminating isolate`);
        void channel?.terminate();
      },
    });
    const workerData: LldbIsolateWorkerData = {
      ...isolate.workerPorts,
      controlPort: controlChannel.port2,
      options: {
        id: options.id,
        name: options.name,
        observerResumesTarget: options.observerResumesTarget ?? false,
        exclusiveModules: options.exclusiveModules ?? false,
        verbose: options.verbose ?? false,
      },
    };
    const workerEntry = import.meta.url.endsWith(".ts")
      ? new URL("./isolate-worker-dev.mjs", import.meta.url)
      : new URL("./isolate-worker.js", import.meta.url);
    try {
      const worker = new Worker(workerEntry, {
        workerData,
        transferList: [...isolate.transferList, controlChannel.port2],
      });
      channel = new LldbIsolateChannel(worker, controlChannel.port1, logger);
      await channel.ready;
      await isolate.connect();
      return new IsolatedLldbComponentRuntime(isolate, channel);
    } catch (error) {
      isolate.close();
      if (channel) await channel.close().catch(() => {});
      else {
        controlChannel.port1.close();
        controlChannel.port2.close();
      }
      throw error;
    }
  }

  async startTarget(): Promise<void> {
    await this.#channel.call("start-target");
  }

  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return this.#isolate.probeModule(module);
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
    return (this.#closePromise ??= this.#close(false));
  }

  /** Force the isolation worker down. Normal cleanup uses close(); this is the
   * containment path for an unresponsive component. Its RPC peer immediately
   * rejects outstanding and subsequent calls when the port closes. */
  terminate(): Promise<void> {
    return (this.#closePromise ??= this.#close(true));
  }

  async #close(force: boolean): Promise<void> {
    this.#isolate.close();
    if (force) await this.#channel.terminate();
    else await this.#channel.close();
  }
}

class LldbIsolateChannel {
  readonly ready: Promise<void>;
  readonly #pending = new Map<number, PendingControl>();
  #nextId = 1;
  #closed = false;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;

  constructor(
    private readonly worker: Worker,
    private readonly port: MessagePort,
    private readonly logger: Logger
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    port.on("message", this.#onMessage);
    port.on("close", this.#onPortClose);
    port.start();
    worker.on("error", this.#onWorkerError);
    worker.on("exit", this.#onWorkerExit);
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
    }
  };

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
    this.port.off("message", this.#onMessage);
    this.port.off("close", this.#onPortClose);
    this.port.close();
  }
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
