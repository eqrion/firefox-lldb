/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LLDBClient, type FileProvider } from "lldb-wasm";
import { noopLogger, type Logger } from "../logging.js";
import {
  SOURCE_DEBUGGER_ABORT_FUNCTION,
  type RdpDebuggeeResumeAction,
  type RdpDebuggeeRunControl,
} from "../gdb/rdp-debuggee.js";
import type { GdbRspConnection, GdbRspEndpoint, SourceDebuggerComponentHost } from "./component.js";
import type { ComponentRunRequest, RunId } from "./types.js";
import {
  LldbSourceDebuggerComponent,
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
  activeTid: number | undefined;
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
  #synchronizeStop: ((tid?: number) => void) | undefined;
  #abortStop: ((tid?: number) => void) | undefined;

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
        activeTid: undefined,
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
    if (releasedAction.kind === "step") pending.activeTid = releasedAction.tid;
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
    if (pending.abortRequested) {
      this.#abortStop?.(pending.activeTid);
    } else if (pending.synchronizeRequested) {
      this.#synchronizeStop?.(pending.activeTid);
    }
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

  installSynchronizeStop(synchronize: (tid?: number) => void): void {
    this.#synchronizeStop = synchronize;
  }

  installAbortStop(abort: (tid?: number) => void): void {
    this.#abortStop = abort;
  }

  synchronizeRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] synchronizing ${runId}`);
    this.#pending.synchronizeRequested = true;
    this.#synchronizeStop?.(this.#pending.activeTid);
  }

  isSynchronizing(runId: RunId): boolean {
    return this.#pending?.request.runId === runId && this.#pending.synchronizeRequested;
  }

  abortRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] aborting ${runId} at shared stop`);
    this.#pending.abortRequested = true;
    this.#abortStop?.(this.#pending.activeTid);
  }
}

export interface EmbeddedLldbComponentRuntimeOptions extends LldbSourceDebuggerComponentOptions {
  host: SourceDebuggerComponentHost;
  logger?: Logger;
  fileProvider?: FileProvider;
  /** Whether an observer releases its own RDP pause lease after arming. Set
   * this false when runtimes share one physical RDP debuggee session. */
  observerResumesTarget?: boolean;
}

// Owns one complete embedded LLDB isolation domain: its wasm worker, pthreads,
// and in-process channels. TCP/RDP resources stay in the component host; this
// runtime imports only transferred GDB RSP byte streams.
export class EmbeddedLldbComponentRuntime {
  readonly component: LldbSourceDebuggerComponentInstance;
  readonly runControl: RdpDebuggeeRunControl;
  readonly #client: LLDBClient;
  readonly #host: SourceDebuggerComponentHost;
  readonly #logger: Logger;
  readonly #rspChannels = new Map<
    number,
    { connection: GdbRspConnection; close: (notifyHost: boolean) => Promise<void> }
  >();
  #closePromise: Promise<void> | undefined;

  private constructor(
    client: LLDBClient,
    options: EmbeddedLldbComponentRuntimeOptions,
    runtimeRunControl: LldbRuntimeRunControl,
    component: LldbSourceDebuggerComponentInstance
  ) {
    this.#client = client;
    this.#host = options.host;
    this.#logger = options.logger ?? noopLogger;
    this.runControl = runtimeRunControl;
    this.component = component;
  }

  static async create(
    options: EmbeddedLldbComponentRuntimeOptions
  ): Promise<EmbeddedLldbComponentRuntime> {
    const client = await LLDBClient.create();
    try {
      if (options.fileProvider) client.setFileProvider(options.fileProvider);
      const logger = options.logger ?? noopLogger;
      const runtimeRunControl = new LldbRuntimeRunControl(
        options.id ?? "lldb",
        logger,
        options.observerResumesTarget ?? true,
        options.exclusiveModules ?? false
      );
      let runtime: EmbeddedLldbComponentRuntime | undefined;
      const definition: LldbSourceDebuggerComponent = new LldbSourceDebuggerComponent(client, {
        id: options.id,
        name: options.name,
        onDispose: () => runtime?.close(),
        runControl: runtimeRunControl,
        exclusiveModules: options.exclusiveModules,
        abortBreakpointFunction: options.exclusiveModules
          ? SOURCE_DEBUGGER_ABORT_FUNCTION
          : undefined,
        logger,
      });
      const component: LldbSourceDebuggerComponentInstance = await definition.instantiate(
        options.host
      );
      runtime = new EmbeddedLldbComponentRuntime(client, options, runtimeRunControl, component);
      return runtime;
    } catch (error) {
      await client.destroy();
      throw error;
    }
  }

  /** Import an already-connected GDB RSP byte stream from the component host.
   * The isolated LLDB never sees the host's TCP socket or the browser-specific
   * server which produced it. */
  async bridgeRsp(connection: GdbRspConnection): Promise<number> {
    if (this.#closePromise) throw new Error(`LLDB component ${this.component.id} is closed`);
    const channelId = await this.#client.createChannel();
    let closed = false;
    const close = async (notifyHost: boolean): Promise<void> => {
      if (closed) return;
      closed = true;
      this.#rspChannels.delete(channelId);
      if (notifyHost) {
        await connection.close().catch(() => {});
      }
      await this.#client.unbridgeChannel(channelId).catch(() => {});
      await this.#client.destroyChannel(channelId).catch(() => {});
    };

    try {
      this.#rspChannels.set(channelId, { connection, close });
      await this.#client.bridgeChannel(channelId, (data) => {
        if (!closed) {
          void connection.write(data).catch((error) => {
            this.#logger.error(
              `[${this.component.id}] LLDB-to-host RSP bridge failed: ${errorMessage(error)}`
            );
            void close(true);
          });
        }
      });
      void (async () => {
        for (;;) {
          const data = await connection.read();
          if (data === null) {
            await close(false);
            return;
          }
          await this.#client.channelServerWrite(channelId, data);
        }
      })().catch((error) => {
        this.#logger.error(
          `[${this.component.id}] host-to-LLDB RSP bridge failed: ${errorMessage(error)}`
        );
        void close(true);
      });
      return channelId;
    } catch (error) {
      await close(true);
      throw error;
    }
  }

  async bridgeRspEndpoint(endpoint: GdbRspEndpoint): Promise<number> {
    return this.bridgeRsp(await this.#host.connectGdbRsp(endpoint));
  }

  async connectPlatform(endpoint: GdbRspEndpoint): Promise<void> {
    const channelId = await this.bridgeRspEndpoint(endpoint);
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
      await Promise.allSettled([...this.#rspChannels.values()].map(({ close }) => close(true)));
      this.#rspChannels.clear();
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
