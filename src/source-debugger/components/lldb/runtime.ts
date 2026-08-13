/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LLDBClient, type FileProvider } from "lldb-wasm";
import { noopLogger, type Logger } from "../../../logging.js";
import { RspServer } from "./rsp/rsp-server.js";
import { startAttachShim } from "./rsp/attach-shim.js";
import { PlatformServer } from "./platform/platform-server.js";
import { GdbServerSpawner } from "./platform/gdb-server-spawner.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "./gdbstub/worker/host.mjs";
import type { SourceDebuggerComponentHost } from "../../protocol/component.js";
import type {
  WasmDebuggee,
  WasmDebuggeeDeferredResume,
  WasmDebuggeeEngineResumeAction,
} from "../../protocol/wasm-debuggee.js";
import type { ComponentRunRequest, RunId } from "../../protocol/types.js";
import {
  LldbSourceDebuggerComponent,
  LldbSourceDebuggerComponentDefinition,
  type LldbComponentRunControl,
  type LldbSourceDebuggerComponentOptions,
} from "./component.js";
import { LldbWasmDebuggeeAdapter, SOURCE_DEBUGGER_ABORT_FUNCTION } from "./debuggee-adapter.js";
import { connectLldbRsp, type LldbRspConnection } from "./rsp-connection.js";

const LLDB_FAILED_STATUS = 6;
const MAX_TRACE_CHARS = 4096;

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

/** Coordinates source-level LLDB operations with the generic session. It sees
 * physical resume proposals from the private gdbstub adapter and turns them
 * into SourceDebuggerRun resume tokens. */
class LldbRuntimeRunControl implements LldbComponentRunControl {
  readonly usesAbortSentinel: boolean;
  #pending: PendingRun | undefined;
  #synchronizeStop: ((tid?: number) => void | Promise<void>) | undefined;
  #abortStop: ((tid?: number) => void | Promise<void>) | undefined;

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

  proposeResume(
    proposed: WasmDebuggeeDeferredResume,
    grantPhysicalResume: (action: WasmDebuggeeEngineResumeAction) => void
  ): void {
    const pending = this.#pending;
    if (!pending) {
      // Native LLDB commands issued outside SourceDebuggerSession retain their
      // ordinary behavior.
      grantPhysicalResume(proposed.action);
      return;
    }
    this.logger.debug(`[${this.id}] armed ${pending.request.runId} as ${pending.request.role}`);
    pending.resolveReady();
    const sequence = ++pending.resumeSequence;
    for (const waiter of pending.resumeWaiters.splice(0)) {
      if (sequence > waiter.afterSequence) waiter.resolve(sequence);
      else pending.resumeWaiters.push(waiter);
    }
    const releasedAction = this.#adjustResumeAction(proposed.action);
    if (releasedAction.kind === "step") pending.activeTid = releasedAction.tid;
    if (pending.request.role === "driver") {
      pending.resumeCallbacks.set(sequence, () => grantPhysicalResume(releasedAction));
      if (this.observerResumesTarget) this.releasePhysicalResume(pending.request.runId, sequence);
    } else if (this.observerResumesTarget) {
      this.logger.debug(
        `[${this.id}] released ${pending.request.role} pause lease for ${pending.request.runId}`
      );
      grantPhysicalResume(releasedAction);
    }
    // A sibling stop can arrive while LLDB is between an internal step-off and
    // its semantic continue. Keep the request latched across every proposal.
    if (pending.abortRequested) {
      void this.#abortStop?.(pending.activeTid);
    } else if (pending.synchronizeRequested) {
      void this.#synchronizeStop?.(pending.activeTid);
    }
  }

  #adjustResumeAction(action: WasmDebuggeeEngineResumeAction): WasmDebuggeeEngineResumeAction {
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
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] completed ${runId}`);
    for (const waiter of this.#pending.resumeWaiters) waiter.resolve(undefined);
    this.#pending = undefined;
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

  installSynchronizeStop(synchronize: (tid?: number) => void | Promise<void>): void {
    this.#synchronizeStop = synchronize;
  }

  installAbortStop(abort: (tid?: number) => void | Promise<void>): void {
    this.#abortStop = abort;
  }

  synchronizeRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] synchronizing ${runId}`);
    this.#pending.synchronizeRequested = true;
    void this.#synchronizeStop?.(this.#pending.activeTid);
  }

  isSynchronizing(runId: RunId): boolean {
    return this.#pending?.request.runId === runId && this.#pending.synchronizeRequested;
  }

  abortRun(runId: RunId): void {
    if (this.#pending?.request.runId !== runId) return;
    this.logger.debug(`[${this.id}] aborting ${runId} at shared stop`);
    this.#pending.abortRequested = true;
    void this.#abortStop?.(this.#pending.activeTid);
  }
}

export interface EmbeddedLldbComponentRuntimeOptions extends LldbSourceDebuggerComponentOptions {
  host: SourceDebuggerComponentHost;
  logger?: Logger;
  fileProvider?: FileProvider;
  /** Compatibility mode for a component driven without SourceDebuggerSession.
   * Session-backed components leave observer resumes gated. */
  observerResumesTarget?: boolean;
  verbose?: boolean;
}

/** One complete LLDB SourceDebuggerComponent isolation domain. Embedded LLDB,
 * its platform server, attach shim, gdbstub component, and every RSP byte
 * stream live here. Its only target import is WasmDebuggee. */
export class EmbeddedLldbComponentRuntime {
  readonly definition: LldbSourceDebuggerComponentDefinition;
  readonly component: LldbSourceDebuggerComponent;
  readonly #client: LLDBClient;
  readonly #host: SourceDebuggerComponentHost;
  readonly #logger: Logger;
  readonly #verbose: boolean;
  readonly #runControl: LldbRuntimeRunControl;
  readonly #rspChannels = new Map<
    number,
    { connection: LldbRspConnection; close: () => Promise<void> }
  >();
  #debuggee: WasmDebuggee | undefined;
  #adapter: LldbWasmDebuggeeAdapter | undefined;
  #platformRsp: RspServer | undefined;
  #spawner: GdbServerSpawner | undefined;
  #targetPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    client: LLDBClient,
    options: EmbeddedLldbComponentRuntimeOptions,
    runtimeRunControl: LldbRuntimeRunControl,
    definition: LldbSourceDebuggerComponentDefinition,
    component: LldbSourceDebuggerComponent
  ) {
    this.#client = client;
    this.definition = definition;
    this.#host = options.host;
    this.#logger = options.logger ?? noopLogger;
    this.#verbose = options.verbose ?? false;
    this.#runControl = runtimeRunControl;
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
        options.observerResumesTarget ?? false,
        options.exclusiveModules ?? false
      );
      let runtime: EmbeddedLldbComponentRuntime | undefined;
      const definition = new LldbSourceDebuggerComponentDefinition(client, {
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
      const component = await definition.instantiate(options.host);
      runtime = new EmbeddedLldbComponentRuntime(
        client,
        options,
        runtimeRunControl,
        definition,
        component
      );
      return runtime;
    } catch (error) {
      await client.destroy();
      throw error;
    }
  }

  /** Build and connect the private LLDB transport stack. Idempotent. */
  startTarget(): Promise<void> {
    if (this.#closePromise) {
      return Promise.reject(new Error(`LLDB component ${this.component.id} is closed`));
    }
    return (this.#targetPromise ??= this.#startTarget());
  }

  async #startTarget(): Promise<void> {
    const debuggee = await this.#host.openWasmDebuggee();
    this.#debuggee = debuggee;
    const adapter = new LldbWasmDebuggeeAdapter(
      debuggee,
      (resume) =>
        this.#runControl.proposeResume(resume, (action) => {
          void debuggee.grantResume(resume.token, action).catch((error) => {
            this.#logger.error(
              `[${this.component.id}] physical resume failed: ${errorMessage(error)}`
            );
          });
        }),
      this.#runControl.usesAbortSentinel
    );
    this.#adapter = adapter;
    this.#runControl.installSynchronizeStop((tid) => adapter.synchronizeStop(tid));
    this.#runControl.installAbortStop((tid) => adapter.abortStop(tid));

    const spawner = new GdbServerSpawner(async ({ port }) => {
      const gdbServer = startGdbServer({
        dispatch: adapter.dispatch,
        port: 0,
        onInfo: (message: string) => this.#logger.debug(`[component] ${message}`),
        onTrace: (message: string) => this.#logger.debug(`[gdbstub] ${boundedTrace(message)}`),
        onError: (message: string) => this.#logger.error(message),
        verbose: this.#verbose,
      });
      await gdbServer.ready;
      const shim = await startAttachShim({
        listenPort: port,
        componentPort: gdbServer.port,
        isValidPid: (pid) => pid === 1,
        trace: this.#verbose ? (message) => this.#logger.debug(`[shim] ${message}`) : undefined,
      });
      let stopPromise: Promise<void> | undefined;
      return {
        port: shim.port,
        stop: () =>
          (stopPromise ??= (async () => {
            const results = await Promise.allSettled([shim.close(), gdbServer.stop()]);
            const errors = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : []
            );
            if (errors.length) throw new AggregateError(errors, "failed to stop LLDB gdbstub");
          })()),
      };
    });
    this.#spawner = spawner;
    const platform = new PlatformServer({
      spawner,
      listTabs: async () => [
        { actor: "wasm-debuggee", url: "wasm-debuggee", title: "Wasm debuggee" },
      ],
      wrapConnectPort: (port) => this.#bridgeTcp(port),
    });
    platform.tabPid("wasm-debuggee");
    const platformRsp = new RspServer(platform, {
      logger: this.#logger,
      singleConnection: true,
    });
    this.#platformRsp = platformRsp;
    const platformPort = await platformRsp.listen(0);
    const channelId = await this.#bridgeTcp(platformPort);
    await this.#checkedCommand("platform select remote-gdb-server");
    await this.#checkedCommand(`platform connect inprocess://${channelId}`);
  }

  async attach(
    pid: number,
    options: { attempts?: number; onRetry?: (attempt: number) => void } = {}
  ): Promise<string> {
    await this.startTarget();
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
      await this.#targetPromise?.catch(() => {});
      const errors: unknown[] = [];
      const clean = async (work: Promise<unknown>) => {
        try {
          await work;
        } catch (error) {
          errors.push(error);
        }
      };
      await clean(this.#platformRsp?.close() ?? Promise.resolve());
      await clean(this.#spawner?.killAll() ?? Promise.resolve());
      await Promise.allSettled([...this.#rspChannels.values()].map(({ close }) => close()));
      this.#rspChannels.clear();
      await clean(this.#adapter?.dispose() ?? this.#debuggee?.dispose() ?? Promise.resolve());
      await clean(Promise.resolve(this.#client.destroy()));
      if (errors.length) {
        throw new AggregateError(errors, `failed to close LLDB component ${this.component.id}`);
      }
    })());
  }

  async #bridgeTcp(port: number): Promise<number> {
    const connection = await connectLldbRsp(port);
    const channelId = await this.#client.createChannel();
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      this.#rspChannels.delete(channelId);
      await connection.close().catch(() => {});
      await this.#client.unbridgeChannel(channelId).catch(() => {});
      await this.#client.destroyChannel(channelId).catch(() => {});
    };
    try {
      this.#rspChannels.set(channelId, { connection, close });
      await this.#client.bridgeChannel(channelId, (data) => {
        if (!closed) {
          void connection.write(data).catch((error) => {
            this.#logger.error(
              `[${this.component.id}] LLDB RSP write failed: ${errorMessage(error)}`
            );
            void close();
          });
        }
      });
      void (async () => {
        for (;;) {
          const data = await connection.read();
          if (data === null) {
            await close();
            return;
          }
          await this.#client.channelServerWrite(channelId, data);
        }
      })().catch((error) => {
        this.#logger.error(`[${this.component.id}] LLDB RSP read failed: ${errorMessage(error)}`);
        void close();
      });
      return channelId;
    } catch (error) {
      await close();
      throw error;
    }
  }

  async #checkedCommand(command: string): Promise<void> {
    const result = await this.#client.sessionCommand(command);
    if (result.status >= LLDB_FAILED_STATUS) {
      throw new Error(result.error || result.output || `${command} failed`);
    }
  }
}

function boundedTrace(message: string): string {
  if (message.length <= MAX_TRACE_CHARS) return message;
  return `${message.slice(0, MAX_TRACE_CHARS)}… [${message.length - MAX_TRACE_CHARS} chars omitted]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
