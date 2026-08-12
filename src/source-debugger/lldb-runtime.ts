/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import { LLDBClient, type FileProvider } from "lldb-wasm";
import { noopLogger, type Logger } from "../logging.js";
import {
  SOURCE_DEBUGGER_ABORT_FUNCTION,
  type RdpDebuggeeResumeAction,
  type RdpDebuggeeRunControl,
} from "../gdb/rdp-debuggee.js";
import type { ComponentRunRequest, RunId } from "./types.js";
import {
  LldbSourceDebuggerComponentInstance,
  type LldbComponentRunControl,
  type LldbSourceDebuggerComponentOptions,
} from "./lldb-component.js";

const LLDB_FAILED_STATUS = 6;

interface PendingRun {
  request: ComponentRunRequest;
  resolveReady: () => void;
  synchronizeRequested: boolean;
  abortRequested: boolean;
  resumeSequence: number;
  resumeCallbacks: Map<number, () => void>;
  resumeWaiters: Array<{
    afterSequence: number;
    resolve: (sequence: number | undefined) => void;
  }>;
}

class LldbRuntimeRunControl implements LldbComponentRunControl, RdpDebuggeeRunControl {
  readonly usesAbortSentinel: boolean;
  #pending: PendingRun | undefined;
  #synchronizeStop: (() => void) | undefined;
  #abortStop: (() => void) | undefined;

  constructor(
    private readonly id: string,
    private readonly logger: Logger,
    private readonly observerResumesTarget: boolean,
    private readonly crossComponentStepping: boolean
  ) {
    this.usesAbortSentinel = crossComponentStepping;
  }

  beginRun(request: ComponentRunRequest): Promise<void> {
    if (this.#pending) throw new Error(`run ${this.#pending.request.runId} is already active`);
    this.logger.debug(`[${this.id}] begin ${request.runId} as ${request.role}`);
    return new Promise<void>((resolveReady) => {
      this.#pending = {
        request,
        resolveReady,
        synchronizeRequested: false,
        abortRequested: false,
        resumeSequence: 0,
        resumeCallbacks: new Map(),
        resumeWaiters: [],
      };
    });
  }

  resume(
    action: RdpDebuggeeResumeAction,
    resumePhysicalTarget: (action: RdpDebuggeeResumeAction) => void
  ): void {
    const pending = this.#pending;
    if (!pending) {
      // Native LLDB commands issued outside SourceDebuggerSession retain their
      // normal behavior during the migration.
      resumePhysicalTarget(action);
      return;
    }
    this.logger.debug(`[${this.id}] armed ${pending.request.runId} as ${pending.request.role}`);
    pending.resolveReady();
    const sequence = ++pending.resumeSequence;
    for (const waiter of pending.resumeWaiters.splice(0)) {
      if (sequence > waiter.afterSequence) waiter.resolve(sequence);
      else pending.resumeWaiters.push(waiter);
    }
    const releasedAction = this.#adjustResumeAction(action);
    if (pending.request.role === "driver") {
      pending.resumeCallbacks.set(sequence, () => resumePhysicalTarget(releasedAction));
      if (this.observerResumesTarget) this.releasePhysicalResume(pending.request.runId, sequence);
    } else if (this.observerResumesTarget) {
      this.logger.debug(
        `[${this.id}] released ${pending.request.role} pause lease for ${pending.request.runId}`
      );
      resumePhysicalTarget(releasedAction);
    }
    // A stop can reach the driver while this LLDB is between an internal
    // step-off and its following semantic continue. Keep synchronization
    // latched so every later local wait in this run observes the already-
    // paused shared target instead of sleeping forever.
    if (pending.abortRequested) this.#abortStop?.();
    else if (pending.synchronizeRequested) this.#synchronizeStop?.();
  }

  #adjustResumeAction(action: RdpDebuggeeResumeAction): RdpDebuggeeResumeAction {
    const request = this.#pending?.request;
    return action.kind === "step" &&
      this.crossComponentStepping &&
      request?.role === "driver" &&
      request.action.kind === "step-into" &&
      action.limit === "next"
      ? { ...action, limit: "step" }
      : action;
  }

  endRun(runId: RunId): void {
    if (this.#pending?.request.runId === runId) {
      this.logger.debug(`[${this.id}] completed ${runId}`);
      for (const waiter of this.#pending.resumeWaiters) waiter.resolve(undefined);
      this.#pending = undefined;
    }
  }

  waitForPhysicalResume(runId: RunId, afterSequence: number): Promise<number | undefined> {
    const pending = this.#pending;
    if (!pending || pending.request.runId !== runId) return Promise.resolve(undefined);
    if (pending.resumeSequence > afterSequence) return Promise.resolve(pending.resumeSequence);
    return new Promise((resolve) => pending.resumeWaiters.push({ afterSequence, resolve }));
  }

  releasePhysicalResume(runId: RunId, sequence: number): void {
    const pending = this.#pending;
    if (!pending || pending.request.runId !== runId) return;
    const resume = pending.resumeCallbacks.get(sequence);
    if (!resume) return;
    pending.resumeCallbacks.delete(sequence);
    this.logger.debug(`[${this.id}] released driver pause lease ${sequence} for ${runId}`);
    resume();
  }

  installSynchronizeStop(synchronize: () => void): void {
    this.#synchronizeStop = synchronize;
  }

  installAbortStop(abort: () => void): void {
    this.#abortStop = abort;
  }

  synchronizeRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] synchronizing ${runId}`);
    this.#pending.synchronizeRequested = true;
    this.#synchronizeStop?.();
  }

  abortRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] aborting ${runId} at shared stop`);
    this.#pending.abortRequested = true;
    this.#abortStop?.();
  }
}

export interface EmbeddedLldbComponentRuntimeOptions extends LldbSourceDebuggerComponentOptions {
  logger?: Logger;
  fileProvider?: FileProvider;
  /** Whether an observer releases its own RDP pause lease after arming. Set
   * this false when runtimes share one physical RDP debuggee session. */
  observerResumesTarget?: boolean;
}

// Owns one complete embedded LLDB isolation domain: its wasm worker, pthreads,
// in-process channels, and the TCP sockets which bridge those channels to RSP
// servers. Keeping this state out of the CLI is what makes constructing two
// LLDB SourceDebuggerComponents in one SourceDebuggerSession practical.
export class EmbeddedLldbComponentRuntime {
  readonly component: LldbSourceDebuggerComponentInstance;
  readonly runControl: RdpDebuggeeRunControl;
  readonly #client: LLDBClient;
  readonly #logger: Logger;
  readonly #sockets = new Set<net.Socket>();
  readonly #runtimeRunControl: LldbRuntimeRunControl;
  #closePromise: Promise<void> | undefined;

  private constructor(client: LLDBClient, options: EmbeddedLldbComponentRuntimeOptions) {
    this.#client = client;
    this.#logger = options.logger ?? noopLogger;
    const id = options.id ?? "lldb";
    this.#runtimeRunControl = new LldbRuntimeRunControl(
      id,
      this.#logger,
      options.observerResumesTarget ?? true,
      options.exclusiveModules ?? false
    );
    this.runControl = this.#runtimeRunControl;
    this.component = new LldbSourceDebuggerComponentInstance(client, {
      id: options.id,
      name: options.name,
      onDispose: () => this.close(),
      runControl: this.#runtimeRunControl,
      exclusiveModules: options.exclusiveModules,
      abortBreakpointFunction: options.exclusiveModules
        ? SOURCE_DEBUGGER_ABORT_FUNCTION
        : undefined,
      logger: this.#logger,
    });
  }

  static async create(
    options: EmbeddedLldbComponentRuntimeOptions = {}
  ): Promise<EmbeddedLldbComponentRuntime> {
    const client = await LLDBClient.create();
    if (options.fileProvider) client.setFileProvider(options.fileProvider);
    return new EmbeddedLldbComponentRuntime(client, options);
  }

  // Bridge a localhost TCP RSP server to a channel owned by this LLDB worker.
  // The method is deliberately an arrow so it can be passed directly as
  // startPlatformServer's wrapConnectPort callback.
  readonly bridgeTcp = async (port: number): Promise<number> => {
    if (this.#closePromise) throw new Error(`LLDB component ${this.component.id} is closed`);
    const channelId = await this.#client.createChannel();
    const socket = net.connect(port, "127.0.0.1");
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.setNoDelay(true);

    // Register before bridgeChannel: loopback may connect while that await is
    // pending, and attaching the listener afterward would miss the event.
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("data", (data) => {
      void this.#client.channelServerWrite(channelId, new Uint8Array(data)).catch((error) => {
        this.#logger.error(
          `[${this.component.id}] server-to-LLDB bridge failed: ${errorMessage(error)}`
        );
        socket.destroy();
      });
    });
    socket.on("error", (error) =>
      this.#logger.warn(`[${this.component.id}] bridge socket error: ${error.message}`)
    );
    await this.#client.bridgeChannel(channelId, (data) => {
      if (!socket.destroyed) socket.write(Buffer.from(data));
    });
    try {
      await connected;
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return channelId;
  };

  async connectPlatform(port: number): Promise<void> {
    const channelId = await this.bridgeTcp(port);
    await this.#checkedCommand("platform select remote-gdb-server");
    await this.#checkedCommand(`platform connect inprocess://${channelId}`);
  }

  async attach(
    pid: number,
    options: { attempts?: number; onRetry?: (attempt: number) => void } = {}
  ): Promise<string> {
    const attempts = options.attempts ?? 4;
    let lastError = "unknown attach failure";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.#client.sessionCommand(`process attach --plugin wasm --pid ${pid}`);
      if (result.status < LLDB_FAILED_STATUS) {
        const state = await this.#client.sessionState();
        if (state.reason !== "none" && state.reason !== "exited") {
          return (result.output + result.error).trimEnd();
        }
        lastError = `process did not stop (state ${state.reason})`;
      } else {
        lastError = (result.error || result.output).trim() || lastError;
      }
      if (attempt < attempts) {
        options.onRetry?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`automatic attach failed after ${attempts} attempts: ${lastError}`);
  }

  command(command: string) {
    return this.#client.sessionCommand(command);
  }

  close(): Promise<void> {
    return (this.#closePromise ??= (async () => {
      for (const socket of this.#sockets) socket.destroy();
      this.#sockets.clear();
      await this.#client.destroy();
    })());
  }

  async #checkedCommand(command: string): Promise<void> {
    const result = await this.#client.sessionCommand(command);
    if (result.status >= LLDB_FAILED_STATUS) {
      throw new Error(result.error || result.output || `${command} failed`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
