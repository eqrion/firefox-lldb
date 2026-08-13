/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Worker } from "node:worker_threads";
import type { ModuleClaim, SourceDebuggerComponent } from "../../protocol/component.js";
import type { ModuleDescriptor } from "../../protocol/types.js";
import type { SourceDebuggerComponentProbe } from "../../session/ownership.js";
import type { SourceDebuggerComponentHostBinding } from "../../target/host.js";
import { SourceDebuggerComponentIsolate } from "../../transport/isolate.js";
import type { WasmTextIsolateMessage, WasmTextIsolateWorkerData } from "./isolate-protocol.js";

export interface IsolatedWasmTextComponentRuntimeOptions {
  host: SourceDebuggerComponentHostBinding;
  id: string;
  name: string;
  requestTimeoutMs?: number;
}

/** Isolated runtime for the direct Wasm-text ecosystem. Its only target access
 * is the WasmDebuggee resource imported over the generic host transport. */
export class IsolatedWasmTextComponentRuntime implements SourceDebuggerComponentProbe {
  readonly #isolate: SourceDebuggerComponentIsolate;
  readonly #worker: Worker;
  #closePromise: Promise<void> | undefined;

  private constructor(isolate: SourceDebuggerComponentIsolate, worker: Worker) {
    this.#isolate = isolate;
    this.#worker = worker;
  }

  static async create(
    options: IsolatedWasmTextComponentRuntimeOptions
  ): Promise<IsolatedWasmTextComponentRuntime> {
    let worker: Worker | undefined;
    const isolate = new SourceDebuggerComponentIsolate(options.host, {
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      onTransportFailure: () => void worker?.terminate(),
    });
    const workerEntry = import.meta.url.endsWith(".ts")
      ? new URL("./isolate-worker-dev.mjs", import.meta.url)
      : new URL("./isolate-worker.js", import.meta.url);
    const workerData: WasmTextIsolateWorkerData = {
      ...isolate.workerPorts,
      options: { id: options.id, name: options.name },
    };
    try {
      worker = new Worker(workerEntry, {
        workerData,
        transferList: isolate.transferList,
      });
      await waitForReady(worker);
      await isolate.connect();
      return new IsolatedWasmTextComponentRuntime(isolate, worker);
    } catch (error) {
      isolate.close();
      await worker?.terminate().catch(() => {});
      throw error;
    }
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

  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return this.#isolate.probeModule(module);
  }

  close(): Promise<void> {
    return (this.#closePromise ??= (async () => {
      this.#isolate.close();
      await this.#worker.terminate();
    })());
  }
}

function waitForReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: WasmTextIsolateMessage): void => {
      if (message.type === "wasm-text-isolate-ready") {
        cleanup();
        resolve();
      } else if (message.type === "wasm-text-isolate-initialization-error") {
        cleanup();
        reject(deserializeError(message.error));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`Wasm text component isolate exited before initialization (${code})`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function deserializeError(error: { name: string; message: string; stack?: string }): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}
