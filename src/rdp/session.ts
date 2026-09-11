/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns one tab's RDP generations, live targets and coherent all-stop state.
// Configure wasm observation before navigation; publish stops only after every
// live target is paused. See INTERNALS.md for ownership and RDP-USAGE.md for wire shapes.

import { RdpClient } from "./client.js";
import { RdpBreakpoints } from "./breakpoints.js";
import type { RdpPacket } from "./transport.js";
import {
  REQUESTS,
  EVENTS,
  ROOT_ACTOR,
  grip,
  hasUrl,
  type TabInfo,
  type RdpTabForm,
  type ListTabsResponse,
  type GetWatcherResponse,
  type GetThreadConfigurationActorResponse,
  type SourceForm,
  type UrlSourceForm,
  type ResourcesAvailableArrayEvent,
  type DocumentEventResource,
  type SourcesResponse,
  type SourceResponse,
  type ArrayBufferGrip,
  type ArrayBufferSliceResponse,
  type LongStringGrip,
  type SubstringResponse,
  type FrameForm,
  type FramesResponse,
  type PauseEvent,
  type StoppedEvent,
  type EvaluateJSAsyncAck,
  type ConsoleApiCallEvent,
  type PageErrorEvent,
} from "./protocol.js";
import { EventEmitter } from "node:events";
import type { WasmFunctionRange } from "../symbols/wasm-bytecode.js";
import { THREAD_CONFIG, browserId, MissingTabError } from "./browser.js";
import { DETACH_GRACE_MS, NAVIGATE_TARGET_TIMEOUT_MS } from "./constants.js";
import { noopLogger, type Logger } from "../diagnostics/logger.js";
import {
  defaultModuleByteProvider,
  isWasmBinary,
  MAX_MODULE_BYTES,
  type ModuleByteProvider,
} from "../symbols/module-bytes.js";
import { requireCompatibleFirefox } from "./firefox-compatibility.js";

export {
  grip,
  type TabInfo,
  type SourceForm,
  type UrlSourceForm,
  type FrameForm,
  type PauseEvent,
  type StoppedEvent,
};

export interface ThreadInfo {
  tid: number;
  /** Top-level target incarnation this thread belongs to. */
  generation: number;
  targetActor: string;
  threadActor: string;
  consoleActor: string;
  url: string;
  isTopLevel: boolean;
}

/** An inspection cannot use the stop snapshot it captured. */
export class RetiredStopError extends Error {
  constructor(stopId: number) {
    super(`stop ${stopId} snapshot retired`);
    this.name = "RetiredStopError";
  }
}

/** Accepted navigation lost its target before a replacement was observed. */
export class NavigationTargetLostError extends Error {
  constructor(
    readonly tabId: number,
    generation: number
  ) {
    super(`Firefox tab ${tabId} lost target generation ${generation} during accepted navigation`);
    this.name = "NavigationTargetLostError";
  }
}

/** One cancellable execution wait, from arming through coherent all-stop. */
export interface StopOperation {
  readonly id: number;
  readonly pending: boolean;
  readonly promise: Promise<StoppedEvent>;
  cancel(error?: Error): void;
}

interface NavigationProgress {
  id: number;
  phase: "waiting" | "destination-ready" | "complete" | "failed";
  requestedUrl: string;
  startingGeneration: number;
  completion?: "document-event" | "tab-navigated";
  destinationGeneration?: number;
  sameTargetStarted?: boolean;
  lastUrl?: string;
}

interface LifecycleLogEntry {
  domain: "rdp" | "target" | "navigation" | "pause" | "cleanup";
  event: string;
  actor?: string;
  generation?: number;
  tid?: number;
  url?: string;
  state?: string;
  detail?: string;
}

export class RdpWasmSession extends EventEmitter {
  #client: RdpClient;
  #logger: Logger;
  #moduleByteProvider: ModuleByteProvider;
  #tabActor!: string;
  #tabId!: number;
  #watcher!: string;

  // tid -> ThreadInfo (including the top-level frame target)
  #threads = new Map<number, ThreadInfo>();
  #retiredTargetActors = new Set<string>();
  #nextTid = 1;
  #nextGeneration = 1;
  #activeGeneration = 0;
  #generationAbort = new AbortController();
  #nextNavigationId = 1;
  #navigation: NavigationProgress | undefined;
  #activeStop?: StopOperation;
  #completedStop?: StoppedEvent;
  #beginStop?: (tid: number, packet: PauseEvent) => void;
  #nextStopId = 1;

  // tid of the thread that triggered the most recent all-stop pause
  #stoppedTid = 1;

  // Paused TIDs include breakpoint, step and interrupt pauses.
  #pausedTids = new Set<number>();
  #resumingTids = new Set<number>();
  // Pauses not yet represented by a completed stop or active collector.
  #unwitnessedPausedTids = new Set<number>();
  // Preserve the actual reason when adopting an already-paused thread.
  #pausePacketByTid = new Map<number, PauseEvent>();
  // Diagnostic listeners must not change whether a pause is witnessed.
  #pauseWitnessCountByTid = new Map<number, number>();

  #breakpoints: RdpBreakpoints;

  #wasmActorByUrl = new Map<string, { actor: string; generation: number }>();
  // Wasm and JS source actors share one namespace.
  // The single owner of actor->url lookups — RdpDebuggee reads it via
  // urlForSourceActor() instead of keeping its own copy.
  #sourceUrlByActor = new Map<string, { url: string; generation: number }>();
  // Actors already reported as URL-less, so a busy page warns once each.
  #warnedUrllessActors = new Set<string>();

  // Pending "is this top-level destroy a real close?" checks (see DETACH_GRACE_MS).
  #pendingDetachChecks = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  #record(entry: LifecycleLogEntry): void {
    const { domain, event, ...detail } = entry;
    this.#logger.debug(
      `[state] ${domain}.${event} ${JSON.stringify({ ...detail, current: this.#currentState() })}`
    );
    this.emit("lifecycle-state");
  }

  #currentState(): object {
    const top = [...this.#threads.values()].find((thread) => thread.isTopLevel);
    return {
      closed: this.#closed,
      tabActor: this.#tabActor || undefined,
      watcherActor: this.#watcher || undefined,
      activeGeneration: this.#activeGeneration,
      topLevel: top
        ? {
            actor: top.targetActor,
            generation: top.generation,
            tid: top.tid,
            url: top.url,
          }
        : undefined,
      threadCount: this.#threads.size,
      pausedTids: [...this.#pausedTids].sort((a, b) => a - b),
      resumingTids: [...this.#resumingTids].sort((a, b) => a - b),
      unwitnessedPausedTids: [...this.#unwitnessedPausedTids].sort((a, b) => a - b),
      pendingTopLevelTid: this.#pendingTopLevelTid,
      navigation: this.#navigation ? { ...this.#navigation } : undefined,
      stopOperation: this.#activeStop
        ? { id: this.#activeStop.id, pending: this.#activeStop.pending }
        : undefined,
    };
  }

  /** Put the current authoritative RDP state at the end of the normal log. */
  logState(event = "snapshot"): void {
    // Observation must not wake lifecycle waiters or advance an operation.
    this.#logger.debug(`[state] rdp.${event} ${JSON.stringify({ current: this.#currentState() })}`);
  }

  #clearPendingDetachChecks(): void {
    for (const timer of this.#pendingDetachChecks) clearTimeout(timer);
    this.#pendingDetachChecks.clear();
  }

  // Reuse the top-level TID across replacement: LLDB can still address it while
  // stepping off a cached breakpoint. Actor/generation identity still changes.
  #pendingTopLevelTid: number | undefined;

  #watchPause(tid: number): void {
    this.#pauseWitnessCountByTid.set(tid, (this.#pauseWitnessCountByTid.get(tid) ?? 0) + 1);
  }

  #unwatchPause(tid: number): void {
    const count = this.#pauseWitnessCountByTid.get(tid) ?? 0;
    if (count <= 1) this.#pauseWitnessCountByTid.delete(tid);
    else this.#pauseWitnessCountByTid.set(tid, count - 1);
  }

  #removeThread(info: ThreadInfo): void {
    this.#breakpoints.removeTarget(info.threadActor);
    this.#rememberRetiredTarget(info.targetActor);
    // A replacement top-level target can already own the same stable tid.
    // Only delete the map entry if it still describes this actor.
    if (this.#threads.get(info.tid)?.targetActor === info.targetActor) {
      this.#threads.delete(info.tid);
      this.#pausedTids.delete(info.tid);
      this.#resumingTids.delete(info.tid);
      this.#unwitnessedPausedTids.delete(info.tid);
      this.#pausePacketByTid.delete(info.tid);
    }
    this.#record({
      domain: "target",
      event: "thread-removed",
      actor: info.targetActor,
      generation: info.generation,
      tid: info.tid,
      url: info.url,
      state: info.isTopLevel ? "top-level" : "worker",
    });
    this.emit(`target-destroyed:${info.targetActor}`, info);
  }

  #retireGeneration(generation: number): void {
    for (const info of [...this.#threads.values()]) {
      if (info.generation === generation) this.#removeThread(info);
    }
  }

  #rememberRetiredTarget(actor: string): void {
    // Evicting tombstones would allow an old available event to resurrect a target.
    if (!this.#retiredTargetActors.has(actor) && this.#retiredTargetActors.size >= 65536)
      throw new Error("RDP retired target limit exceeded (65536); reconnect required");
    this.#retiredTargetActors.add(actor);
  }

  #rememberSource(source: UrlSourceForm, generation: number): void {
    if (!this.#sourceUrlByActor.has(source.actor) && this.#sourceUrlByActor.size >= 16384)
      throw new Error("RDP source actor limit exceeded (16384 per generation)");
    if (source.introductionType === "wasm") {
      if (!this.#wasmActorByUrl.has(source.url) && this.#wasmActorByUrl.size >= 4096)
        throw new Error("RDP wasm module limit exceeded (4096 per generation)");
      this.#wasmActorByUrl.set(source.url, { actor: source.actor, generation });
    }
    this.#sourceUrlByActor.set(source.actor, { url: source.url, generation });
  }

  // Retire source identities together with their top-level generation.
  #invalidateActorCaches(): void {
    this.#wasmActorByUrl.clear();
    this.#sourceUrlByActor.clear();
    this.#warnedUrllessActors.clear();
  }

  // Invalidate generation-owned work immediately. The separate, grace-gated
  // detached event distinguishes a tab close from an in-progress replacement.
  #onTopLevelGone(info?: ThreadInfo): void {
    this.#generationAbort.abort(new Error("RDP target generation retired"));
    this.#invalidateActorCaches();
    this.#record({
      domain: "target",
      event: "top-level-gone",
      actor: info?.targetActor,
      generation: info?.generation,
      tid: info?.tid,
      url: info?.url,
    });
    this.emit("navigated", info);
  }

  private constructor(client: RdpClient, logger: Logger, moduleByteProvider: ModuleByteProvider) {
    super();
    this.#client = client;
    this.#logger = logger;
    this.#breakpoints = new RdpBreakpoints(client, logger);
    this.#moduleByteProvider = moduleByteProvider;
    this.#record({ domain: "rdp", event: "session-created" });
    // Forward transport close so consumers can unblock pending promises.
    client.on("close", () => {
      this.#breakpoints.close();
      this.#closed = true;
      this.#generationAbort.abort(new Error("RDP session closed"));
      this.#clearPendingDetachChecks();
      this.#record({ domain: "rdp", event: "transport-closed" });
      this.emit("close");
    });
    client.on("error", (err: Error) => {
      this.close();
      this.#record({ domain: "rdp", event: "transport-error", detail: err.message });
      this.#logger.error(`[rdp] transport error: ${err.message}`);
    });
  }

  // --- public accessors ---

  get stoppedTid(): number {
    return this.#stoppedTid;
  }

  get tabId(): number {
    return this.#tabId;
  }

  /**
   * Choose a live thread for a user-requested interrupt. Prefer a running
   * worker so Ctrl-C taken while pthreads are blocked in wasm reports the
   * worker's real pause, rather than an idle top-level JS thread.
   */
  preferredInterruptTid(): number | undefined {
    const threads = [...this.#threads.values()];
    const running = threads.filter((thread) => !this.#pausedTids.has(thread.tid));
    return (
      running.find((thread) => !thread.isTopLevel)?.tid ??
      running[0]?.tid ??
      threads.find((thread) => !thread.isTopLevel)?.tid ??
      threads[0]?.tid
    );
  }

  /** Currently-paused tids, in the same stopped-thread-first order as listTids(). */
  pausedTids(): number[] {
    return this.listTids().filter((tid) => this.#pausedTids.has(tid));
  }

  /**
   * Prefer a different paused thread as the user-visible all-stop trigger.
   * Used after Ctrl-C when the initially interrupted worker has no RDP frames
   * but another worker caught by the same all-stop has a live wasm stack.
   */
  selectStoppedTid(tid: number): void {
    if (this.#pausedTids.has(tid)) this.#stoppedTid = tid;
  }

  hasThreads(): boolean {
    return this.#threads.size > 0;
  }

  /** True when at least one thread is paused (breakpoint, step, or interrupt). */
  paused(): boolean {
    return this.#pausedTids.size > 0;
  }

  /**
   * True when a thread paused with no armAllStop listener catching it — e.g.
   * a newly-navigated page's buffered breakpoint fires before the next
   * Debuggee.continue arms the all-stop machinery. Resuming it blindly
   * (resumeAll()) would run straight past that pause instead of reporting
   * it. Distinct from paused(): a tid left in #pausedTids by a normal,
   * already-witnessed stop (e.g. primeStop's initial interrupt) is not one
   * of these, and remains safe to resume.
   */
  hasUnwitnessedPause(): boolean {
    return this.#unwitnessedPausedTids.size > 0;
  }

  listTids(): number[] {
    return [...this.#threads.keys()];
  }

  /** URL of the top-level (page) target, if one is connected. */
  topLevelUrl(): string | undefined {
    return [...this.#threads.values()].find((t) => t.isTopLevel)?.url;
  }

  /** Current top-level target incarnation, or 0 while no top-level target exists. */
  topLevelGeneration(): number {
    return [...this.#threads.values()].find((t) => t.isTopLevel)?.generation ?? 0;
  }

  /** Stable debugger tid assigned to the current top-level target. */
  topLevelTid(): number | undefined {
    return [...this.#threads.values()].find((t) => t.isTopLevel)?.tid;
  }

  #waitForState(
    predicate: () => boolean,
    timeoutMs: number,
    timeoutMessage: string,
    closeMessage: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (predicate()) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error(closeMessage));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("lifecycle-state", onState);
        this.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onState = () => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error(closeMessage));
      };
      const onAbort = () => {
        cleanup();
        reject(signal!.reason);
      };
      timer = setTimeout(() => {
        cleanup();
        this.#record({ domain: "rdp", event: "wait-timeout", detail: timeoutMessage });
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.on("lifecycle-state", onState);
      this.on("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the check-subscribe race if state changed between the initial
      // predicate above and listener registration.
      onState();
    });
  }

  #observeNavigationTarget(url: string, generation: number): void {
    const navigation = this.#navigation;
    if (!navigation || navigation.phase !== "waiting") return;
    if (generation === navigation.startingGeneration) return;
    if (navigation.requestedUrl !== "about:blank" && url === "about:blank") return;
    navigation.destinationGeneration = generation;
    navigation.lastUrl = url;
    this.#record({
      domain: "navigation",
      event: "destination-target",
      generation,
      url,
      detail: `navigation=${navigation.id}`,
    });
  }

  #completeNavigation(
    completion: "document-event" | "tab-navigated",
    url: string,
    generation: number
  ): void {
    const navigation = this.#navigation;
    if (!navigation || navigation.phase !== "waiting") return;
    if (navigation.requestedUrl !== "about:blank" && url === "about:blank") return;
    if (generation === navigation.startingGeneration && !navigation.sameTargetStarted) return;
    if (
      navigation.destinationGeneration !== undefined &&
      generation !== navigation.destinationGeneration
    )
      return;
    if (url !== navigation.requestedUrl && url !== navigation.lastUrl) return;
    navigation.destinationGeneration = generation;
    navigation.phase = "destination-ready";
    navigation.completion = completion;
    navigation.lastUrl = url;
    this.#record({
      domain: "navigation",
      event: "destination-ready",
      generation,
      url,
      state: completion,
      detail: `navigation=${navigation.id}`,
    });
  }

  /** Wait until watchTargets has announced the tab's initial top-level target.
   * The watchTargets request can resolve before its target-available event is
   * delivered. Callers that navigate immediately must not treat that late
   * initial about:blank target as the replacement created by navigation. */
  waitForTopLevelTarget(timeoutMs = 10_000): Promise<void> {
    this.#record({ domain: "target", event: "initial-target-wait-started" });
    return this.#waitForState(
      () => this.topLevelTid() !== undefined,
      timeoutMs,
      `no initial top-level target within ${timeoutMs}ms`,
      "session closed while waiting for the initial top-level target"
    ).then(() => {
      this.#record({
        domain: "target",
        event: "initial-target-ready",
        generation: this.topLevelGeneration(),
        tid: this.topLevelTid(),
        url: this.topLevelUrl(),
      });
    });
  }

  /** Connect, enable wasm observation, and start watching targets. */
  static async start(
    port = 6080,
    host = "127.0.0.1",
    tabId?: number,
    logger: Logger = noopLogger,
    moduleByteProvider: ModuleByteProvider = defaultModuleByteProvider,
    signal?: AbortSignal
  ): Promise<RdpWasmSession> {
    const client = await RdpClient.connect(port, host, { logger, signal });
    const session = new RdpWasmSession(client, logger, moduleByteProvider);
    try {
      await session.#init(tabId);
      signal?.throwIfAborted();
      return session;
    } catch (err) {
      // Initialization is transactional: callers commonly retry while Firefox
      // is still starting, so retaining the failed socket would leak one RDP
      // connection per attempt.
      session.#record({
        domain: "rdp",
        event: "initialization-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      client.close();
      throw err;
    }
  }

  async #init(tabId?: number): Promise<void> {
    const runtime = await requireCompatibleFirefox(this.#client, this.#logger);
    this.#record({
      domain: "rdp",
      event: "compatibility-verified",
      detail: `${runtime.version}${runtime.channel ? ` ${runtime.channel}` : ""}`,
    });
    const { tabs } = (await this.#client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse & { tabs?: (RdpTabForm & { selected?: boolean })[] };
    const tab =
      tabId !== undefined
        ? tabs?.find((candidate) => browserId(candidate) === tabId)
        : (tabs?.find((candidate) => candidate.selected) ?? tabs?.[0]);
    if (!tab) {
      if (tabId !== undefined) throw new MissingTabError(tabId);
      throw new Error("no Firefox tab found (Firefox may still be starting)");
    }
    this.#tabId = browserId(tab);
    this.#tabActor = tab.actor;
    this.#record({ domain: "rdp", event: "tab-selected", actor: this.#tabActor, url: tab.url });

    const watcherResp = (await this.#client.request(this.#tabActor, {
      type: REQUESTS.getWatcher,
      isServerTargetSwitchingEnabled: true,
    })) as GetWatcherResponse;
    const watcher = watcherResp.actor;
    if (!watcher) throw new Error("Firefox did not return a watcher actor");
    this.#watcher = watcher;
    this.#record({ domain: "rdp", event: "watcher-ready", actor: watcher });

    const cfg = (await this.#client.request(this.#watcher, {
      type: REQUESTS.getThreadConfigurationActor,
    })) as GetThreadConfigurationActorResponse;
    const configActor =
      typeof cfg.configuration === "string" ? cfg.configuration : cfg.configuration?.actor;
    if (!configActor) throw new Error("Firefox did not return a thread config actor");
    await this.#client.request(configActor, {
      type: REQUESTS.updateConfiguration,
      configuration: THREAD_CONFIG,
    });
    this.#record({ domain: "rdp", event: "thread-configuration-applied", actor: configActor });

    this.#client.on("event", (p) => {
      try {
        this.#onEvent(p);
      } catch (error) {
        this.#logger.error(
          `[rdp] event processing failed: ${error instanceof Error ? error.stack : error}`
        );
        this.close();
      }
    });
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchTargets,
      targetType: "frame",
    });
    this.#record({ domain: "rdp", event: "frame-target-watch-ready", actor: this.#watcher });
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchTargets,
      targetType: "worker",
    });
    this.#record({ domain: "rdp", event: "worker-target-watch-ready", actor: this.#watcher });
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchResources,
      resourceTypes: ["source", "document-event"],
    });
    this.#record({ domain: "rdp", event: "source-watch-ready", actor: this.#watcher });
  }

  #onEvent(p: RdpPacket): void {
    if (this.#closed) return;
    switch (p.type) {
      case EVENTS.targetAvailableForm: {
        const target = p.target as {
          actor?: string;
          url?: string;
          threadActor?: string;
          consoleActor?: string;
          isTopLevelTarget?: boolean;
        };
        const targetActor = target?.actor;
        const threadActor = target?.threadActor;
        if (!targetActor || !threadActor) {
          this.#record({
            domain: "target",
            event: "target-available-ignored",
            detail: "missing target or thread actor",
          });
          break;
        }

        if (this.#retiredTargetActors.has(targetActor)) {
          this.#record({ domain: "target", event: "retired-actor-ignored", actor: targetActor });
          break;
        }
        // Check if this actor is already known (re-announce after navigation).
        const existing = [...this.#threads.values()].find((t) => t.targetActor === targetActor);
        if (existing) {
          this.#record({
            domain: "target",
            event: "target-available-duplicate",
            actor: targetActor,
            generation: existing.generation,
            tid: existing.tid,
            url: existing.url,
          });
          break;
        }

        const isTopLevel = target.isTopLevelTarget ?? false;
        let tid: number;
        let generation = this.#activeGeneration;
        if (isTopLevel) {
          // A top-level arrival starts a new target incarnation. Firefox
          // normally sends destroy-then-available, but some process switches
          // announce the replacement first. Retire the old generation here in
          // that ordering so two top-level targets never coexist and the
          // replacement still inherits LLDB's stable tid.
          const currentTop = [...this.#threads.values()].find((t) => t.isTopLevel);
          this.#clearPendingDetachChecks();
          if (currentTop) {
            tid = currentTop.tid;
            this.#retireGeneration(currentTop.generation);
            this.#onTopLevelGone(currentTop);
          } else if (this.#pendingTopLevelTid !== undefined) {
            tid = this.#pendingTopLevelTid;
          } else {
            tid = this.#nextTid++;
          }
          this.#pendingTopLevelTid = undefined;
          generation = this.#nextGeneration++;
          this.#activeGeneration = generation;
          this.#generationAbort = new AbortController();
          // Workers can be announced in the destroy/available gap. Adopt them
          // into the new incarnation once its top-level target identifies it.
          for (const thread of this.#threads.values()) {
            if (thread.generation === 0) {
              thread.generation = generation;
              this.#observeBreakpointTarget(thread);
            }
          }
        } else {
          tid = this.#nextTid++;
        }
        const info: ThreadInfo = {
          tid,
          generation,
          targetActor,
          threadActor,
          consoleActor: target.consoleActor ?? "",
          url: target.url ?? "",
          isTopLevel,
        };
        if (this.#threads.size >= 1024) throw new Error("RDP live target limit exceeded (1024)");
        this.#threads.set(tid, info);
        this.#observeBreakpointTarget(info);
        this.#record({
          domain: "target",
          event: "target-available",
          actor: targetActor,
          generation,
          tid,
          url: info.url,
          state: isTopLevel ? "top-level" : "worker",
        });
        if (isTopLevel) this.#observeNavigationTarget(info.url, generation);

        this.emit("target", info);
        break;
      }
      case EVENTS.tabNavigated: {
        const currentTop = [...this.#threads.values()].find((t) => t.isTopLevel);
        if (!currentTop || (p.from !== currentTop.targetActor && p.from !== this.#tabActor)) {
          this.#record({ domain: "navigation", event: "retired-sender-ignored", actor: p.from });
          break;
        }
        const event = p as { url?: unknown; state?: unknown; target?: { url?: unknown } };
        const url = typeof event.url === "string" ? event.url : event.target?.url;
        if (typeof url !== "string") {
          this.#record({
            domain: "navigation",
            event: "tab-navigated-ignored",
            detail: "missing URL",
          });
          break;
        }
        // A process-switch navigation may first announce a replacement frame
        // as about:blank, then complete that same target via tabNavigated
        // without another target-available-form. Keep the target form current
        // and let navigate() use the stop notification as its load barrier.
        const state = typeof event.state === "string" ? event.state : undefined;
        const navigation = this.#navigation;
        if (state === "start" && navigation?.phase === "waiting") {
          navigation.sameTargetStarted = currentTop.generation === navigation.startingGeneration;
          navigation.lastUrl = url;
        }
        if (
          navigation?.phase === "waiting" &&
          state !== "start" &&
          url !== navigation.requestedUrl &&
          url !== navigation.lastUrl
        )
          break;
        currentTop.url = url;
        this.#record({
          domain: "navigation",
          event: "tab-navigated",
          actor: currentTop?.targetActor,
          generation: currentTop?.generation,
          tid: currentTop?.tid,
          url,
          state,
        });
        if (currentTop && (state === undefined || state === "stop")) {
          this.#completeNavigation("tab-navigated", url, currentTop.generation);
        }
        this.emit("tab-navigated", {
          url,
          state,
        });
        break;
      }
      case EVENTS.targetDestroyedForm: {
        // Destroy events identify the target actor, not the thread actor.
        const target = p.target as { actor?: string };
        const targetActor = target?.actor;
        if (!targetActor) {
          this.#record({
            domain: "target",
            event: "target-destroyed-ignored",
            detail: "missing target actor",
          });
          break;
        }
        const entry = [...this.#threads.entries()].find(([, t]) => t.targetActor === targetActor);
        if (entry) {
          const [, info] = entry;
          this.#record({
            domain: "target",
            event: "target-destroyed",
            actor: targetActor,
            generation: info.generation,
            tid: info.tid,
            url: info.url,
            state: info.isTopLevel ? "top-level" : "worker",
          });
          // The page's tab was closed or navigated away; let consumers react
          // (e.g. firefox-lldb detaches the lldb process). Give a Fission
          // process-swap replacement (see DETACH_GRACE_MS) a chance to arrive
          // first, so a swap isn't mistaken for a real close.
          if (info.isTopLevel) {
            // Retire the entire incarnation, including workers whose own
            // destroyed events may arrive later. They cannot remain valid once
            // their owning page target is gone.
            this.#retireGeneration(info.generation);
            if (this.#activeGeneration === info.generation) this.#activeGeneration = 0;
            // Whether this was a navigate() we drove or the page navigating
            // on its own, every source actor scoped to the old top-level
            // target is now dead.
            this.#onTopLevelGone(info);
            // Offer this tid to whatever top-level target replaces this one
            // (see #pendingTopLevelTid). If nothing does — a genuine close —
            // the timeout below clears it; nothing will ever ask for it again.
            this.#pendingTopLevelTid = info.tid;
            const timer = setTimeout(() => {
              this.#pendingDetachChecks.delete(timer);
              const hasTopLevel = [...this.#threads.values()].some((t) => t.isTopLevel);
              if (!hasTopLevel) {
                this.#pendingTopLevelTid = undefined;
                this.#record({
                  domain: "target",
                  event: "tab-detached",
                  actor: info.targetActor,
                  generation: info.generation,
                  tid: info.tid,
                  url: info.url,
                });
                this.emit("detached", info);
              }
            }, DETACH_GRACE_MS);
            this.#pendingDetachChecks.add(timer);
          } else {
            this.#removeThread(info);
          }
        } else {
          this.#rememberRetiredTarget(targetActor);
          this.#record({
            domain: "target",
            event: "target-destroyed-unknown",
            actor: targetActor,
          });
        }
        break;
      }
      case EVENTS.resourcesAvailableArray: {
        // Worker source actors are thread-local; retain every actor-to-URL mapping.
        const groups = (p as ResourcesAvailableArrayEvent).array;
        if (!groups) break;
        for (const group of groups) {
          if (!Array.isArray(group) || !Array.isArray(group[1])) continue;
          if (group[0] === "source") {
            const owner = [...this.#threads.values()].find(
              (thread) => thread.targetActor === p.from
            );
            if (!owner || owner.generation === 0) continue;
            for (const source of group[1] as SourceForm[]) {
              if (!source.actor || !this.#reportUsableSource(source)) continue;
              this.#rememberSource(source, owner.generation);
            }
            this.#observeBreakpointSources(owner, group[1] as SourceForm[]);
          } else if (group[0] === "document-event") {
            // Unlike source resources, document events identify their target
            // through the packet's `from` actor. Tie readiness to that actor's
            // generation so a late event from the retired document cannot
            // complete the new navigation.
            const fromActor = p.from as string;
            const info = [...this.#threads.values()].find(
              (thread) => thread.targetActor === fromActor && thread.isTopLevel
            );
            if (!info) continue;
            for (const event of group[1] as DocumentEventResource[]) {
              if (event.name !== "dom-interactive" && event.name !== "dom-complete") continue;
              const eventUrl = event.url ?? info.url;
              this.#record({
                domain: "navigation",
                event: `document-${event.name}`,
                actor: fromActor,
                generation: info.generation,
                tid: info.tid,
                url: eventUrl,
              });
              this.#completeNavigation("document-event", eventUrl, info.generation);
            }
          }
        }
        break;
      }
      case EVENTS.paused: {
        const fromActor = p.from as string;
        const entry = [...this.#threads.entries()].find(([, t]) => t.threadActor === fromActor);
        if (!entry) break;
        const [tid] = entry;
        this.#pausedTids.add(tid);
        this.#resumingTids.delete(tid);
        this.#pausePacketByTid.set(tid, p as PauseEvent);
        // Preserve a pause with no collector so the next continue reports it first.
        if ((this.#pauseWitnessCountByTid.get(tid) ?? 0) === 0) {
          this.#unwitnessedPausedTids.add(tid);
        }
        const pauseType = (p as PauseEvent).why?.type;
        this.#record({
          domain: "pause",
          event: "paused",
          actor: fromActor,
          generation: entry[1].generation,
          tid,
          state: typeof pauseType === "string" ? pauseType : "unknown",
        });
        this.emit(`paused:${tid}`, p as PauseEvent);
        // Generic form for listeners that do not yet know which tids exist
        // (navigate() waiting out a load-time pause).
        this.emit("paused", tid, p as PauseEvent);
        break;
      }
      case EVENTS.resumed: {
        const fromActor = p.from as string;
        const entry = [...this.#threads.entries()].find(([, t]) => t.threadActor === fromActor);
        if (entry) {
          this.#completedStop = undefined;
          const [tid] = entry;
          this.#pausedTids.delete(tid);
          this.#resumingTids.delete(tid);
          this.#pausePacketByTid.delete(tid);
          this.#unwitnessedPausedTids.delete(tid);
          this.#record({
            domain: "pause",
            event: "resumed",
            actor: fromActor,
            generation: entry[1].generation,
            tid,
          });
        }
        break;
      }
    }
  }

  /** Navigate the tab; resolves once Firefox accepts the request and the
   * destination document reaches DOM interactive. */
  async navigate(url: string, timeoutMs = NAVIGATE_TARGET_TIMEOUT_MS): Promise<void> {
    if (this.#navigation?.phase === "waiting" || this.#navigation?.phase === "destination-ready") {
      this.#record({
        domain: "navigation",
        event: "concurrent-request-rejected",
        url,
        detail: `active-navigation=${this.#navigation.id}`,
      });
      throw new Error(`navigation ${this.#navigation.id} is already in progress`);
    }
    // Do not mutate live target state before Firefox accepts the request. The
    // watcher events perform the generation swap transactionally; if navigateTo
    // is rejected, the existing generation remains usable.
    const startingGeneration = this.topLevelGeneration();
    const navigation: NavigationProgress = {
      id: this.#nextNavigationId++,
      phase: "waiting",
      requestedUrl: url,
      startingGeneration,
    };
    this.#navigation = navigation;
    this.#record({
      domain: "navigation",
      event: "request-started",
      generation: startingGeneration,
      url,
      detail: `navigation=${navigation.id}`,
    });
    const destinationAbort = new AbortController();
    let requestReplied = false;
    const destination = this.#waitForState(
      () => navigation.phase === "destination-ready",
      timeoutMs,
      `no completed top-level navigation within ${timeoutMs}ms`,
      "session closed during navigate",
      destinationAbort.signal
    ).catch((error: unknown) => {
      // A detach grace is only a heuristic: a slow replacement can still
      // arrive. Classify missing targets at the navigation deadline, never
      // turn cancellation, connection loss or request rejection into a retry.
      if (
        !this.#closed &&
        !destinationAbort.signal.aborted &&
        requestReplied &&
        startingGeneration !== 0 &&
        this.topLevelGeneration() === 0
      )
        throw new NavigationTargetLostError(this.#tabId, startingGeneration);
      throw error;
    });
    // A pause during navigation can arrive before the replacement target is
    // announced. Resume past it so target discovery can finish; the attach
    // sequence makes its own stop afterwards (RdpDebuggee.primeStop).
    const onPausedDuringLoad = (tid: number) => {
      this.#logger.debug(`[rdp] resuming tid ${tid} paused during navigation to ${url}`);
      this.#record({
        domain: "navigation",
        event: "load-pause-resumed",
        generation: this.topLevelGeneration(),
        tid,
        url,
        detail: `navigation=${navigation.id}`,
      });
      const info = this.#threads.get(tid);
      if (info) this.#requestResume(info);
    };
    this.on("paused", onPausedDuringLoad);
    try {
      const request = this.#client
        .request(this.#tabActor, {
          type: REQUESTS.navigateTo,
          url,
          // Firefox Nightly can create the destination target and load all of
          // its sources yet never answer a waitForLoad:true request. Ask only
          // for navigation initiation and use the destination target's
          // document-event as our independent readiness barrier. This also
          // avoids deadlocking when pauseOnExceptions stops a loading script
          // before `load` fires.
          waitForLoad: false,
        })
        .then(() => {
          requestReplied = true;
          this.#record({
            domain: "navigation",
            event: "request-replied",
            generation: this.topLevelGeneration(),
            url: this.topLevelUrl(),
            detail: `navigation=${navigation.id}`,
          });
        });
      // Both facts are required, but either may arrive first. Waiting in
      // parallel also lets the lifecycle deadline fail promptly if Firefox
      // withholds the navigateTo reply after losing the completion event.
      await Promise.all([request, destination]);
      destinationAbort.signal.throwIfAborted();
      if (this.topLevelGeneration() !== navigation.destinationGeneration)
        throw new Error("navigation destination retired before request acceptance");
      navigation.phase = "complete";
      this.#record({
        domain: "navigation",
        event: "complete",
        generation: this.topLevelGeneration(),
        url: this.topLevelUrl(),
        state: navigation.completion,
        detail: `navigation=${navigation.id}`,
      });
    } catch (err) {
      navigation.phase = "failed";
      this.#record({
        domain: "navigation",
        event: "failed",
        generation: this.topLevelGeneration(),
        url: this.topLevelUrl(),
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      destinationAbort.abort();
      this.off("paused", onPausedDuringLoad);
    }
  }

  /** Find the ThreadInfo for a tid; throw if unknown. */
  #info(tid: number): ThreadInfo {
    const info = this.#threads.get(tid);
    if (!info) throw new Error(`no thread for tid ${tid}`);
    return info;
  }

  #isCurrentThread(info: ThreadInfo): boolean {
    return !this.#closed && this.#threads.get(info.tid) === info;
  }

  // --- wasm sources ---

  /** Wasm sources from the given thread. */
  async wasmSourcesForTid(tid: number): Promise<UrlSourceForm[]> {
    return this.#wasmSourcesForInfo(this.#info(tid));
  }

  async #wasmSourcesForInfo(info: ThreadInfo): Promise<UrlSourceForm[]> {
    const { sources } = (await this.#client.request(info.threadActor, {
      type: REQUESTS.sources,
    })) as SourcesResponse;
    if (!this.#isCurrentThread(info)) return [];
    const wasm = (sources ?? [])
      .filter((s) => s.introductionType === "wasm")
      .filter((s) => this.#reportUsableSource(s));
    for (const s of wasm) {
      this.#rememberSource(s, info.generation);
    }
    this.#observeBreakpointSources(info, wasm);
    return wasm;
  }

  // Firefox requires sourceUrl for breakpoints. Warn for unsupported wasm;
  // ordinary URL-less eval scripts use debug logging. Warning retention is bounded.
  #reportUsableSource(s: SourceForm): s is UrlSourceForm {
    if (hasUrl(s)) return true;
    if (!this.#warnedUrllessActors.has(s.actor) && this.#warnedUrllessActors.size < 1024) {
      this.#warnedUrllessActors.add(s.actor);
      const msg =
        `[rdp] ignoring ${s.introductionType ?? "unknown"} source ${s.actor}: ` +
        `Firefox reports no URL for it, and a breakpoint can only be addressed by URL`;
      if (s.introductionType === "wasm") this.#logger.warn(msg);
      else this.#logger.debug(msg);
      if (this.#warnedUrllessActors.size === 1024)
        this.#logger.warn("[rdp] further URL-less source warnings suppressed for this generation");
    }
    return false;
  }

  /** Wasm sources deduped by URL across all known threads. */
  async wasmSources(): Promise<UrlSourceForm[]> {
    // Prefer the top-level source list; retry another thread only if this one retires.
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    for (const tid of tids) {
      const info = this.#threads.get(tid);
      if (!info) continue;
      try {
        return await this.#wasmSourcesForInfo(info);
      } catch (error) {
        if (this.#closed || this.#isCurrentThread(info)) throw error;
      }
    }
    return [];
  }

  /** URL for a wasm or JS source actor, if known (populated by wasmSourcesForTid/jsSources). */
  urlForSourceActor(actor: string): string | undefined {
    const entry = this.#sourceUrlByActor.get(actor);
    return entry?.generation === this.#activeGeneration ? entry.url : undefined;
  }

  async fetchModuleBytes(url: string): Promise<Uint8Array | undefined> {
    const { signal } = this.#generationAbort;
    signal.throwIfAborted();
    // WIT Module.bytecode uses an option: unavailable is not an empty wasm module.
    if (typeof url !== "string") {
      this.#logger.error(`[rdp] module bytes requested for a source with no URL (${url})`);
      return undefined;
    }
    const actorEntry = this.#wasmActorByUrl.get(url);
    const actor = actorEntry?.generation === this.#activeGeneration ? actorEntry.actor : undefined;
    if (actor) {
      const bytes = await this.#fetchWasmBytesFromActor(actor);
      signal.throwIfAborted();
      if (bytes && isWasmBinary(bytes)) {
        this.#logger.debug(
          `[rdp] module-bytes ${JSON.stringify({ url, actor, generation: this.#activeGeneration, provider: "browser", bytes: bytes.length })}`
        );
        return bytes;
      }
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      this.#logger.warn(
        `[rdp] browser bytes unavailable for ${url}; HTTP fallback cannot establish loaded-module identity`
      );
      try {
        const bytes = await this.#moduleByteProvider.fetch(url, signal);
        signal.throwIfAborted();
        if (!isWasmBinary(bytes)) throw new Error("HTTP fallback did not provide a wasm binary");
        this.#logger.debug(
          `[rdp] module-bytes ${JSON.stringify({ url, generation: this.#activeGeneration, provider: "http-fallback", bytes: bytes.length })}`
        );
        return bytes;
      } catch (error) {
        signal.throwIfAborted();
        this.#logger.warn(`[rdp] module HTTP fallback failed for ${url}: ${error}`);
      }
    }
    this.#logger.error(`[rdp] could not acquire valid module bytes for ${url}`);
    return undefined;
  }

  /** Try to fetch raw wasm bytes from a source actor via RDP. */
  async #fetchWasmBytesFromActor(sourceActor: string): Promise<Uint8Array | null> {
    const actorLifetime = this.#generationAbort.signal;
    try {
      const resp = (await this.#client.request(
        sourceActor,
        {
          type: REQUESTS.source,
        },
        { actorLifetime }
      )) as SourceResponse;
      actorLifetime.throwIfAborted();
      const src = resp.source;
      if (src instanceof Uint8Array) return src;
      if (ArrayBuffer.isView(src)) {
        const view = src as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
      if (src instanceof ArrayBuffer) return new Uint8Array(src);
      if (
        src &&
        typeof src === "object" &&
        (src as Partial<ArrayBufferGrip>).typeName === "arraybuffer"
      ) {
        const grip = src as ArrayBufferGrip;
        if (!Number.isInteger(grip.length) || grip.length < 0 || grip.length > MAX_MODULE_BYTES) {
          throw new Error(`invalid ArrayBuffer length ${grip.length}`);
        }
        let sliced: ArrayBufferSliceResponse;
        try {
          sliced = (await this.#client.request(
            grip.actor,
            {
              type: REQUESTS.slice,
              start: 0,
              count: grip.length,
            },
            { actorLifetime }
          )) as ArrayBufferSliceResponse;
        } finally {
          if (!actorLifetime.aborted)
            await this.#client
              .request(grip.actor, { type: REQUESTS.release })
              .catch((err) =>
                this.#logger.debug(
                  `[rdp] could not release ArrayBuffer actor ${grip.actor}: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                )
              );
        }
        if (typeof sliced.encoded !== "string") throw new Error("ArrayBuffer slice has no data");
        const bytes = Uint8Array.from(Buffer.from(sliced.encoded, "base64"));
        if (bytes.length !== grip.length) {
          throw new Error(`ArrayBuffer slice length mismatch (${bytes.length} != ${grip.length})`);
        }
        return bytes;
      }
      if (typeof src === "string" && src.length > 4 && src.charCodeAt(0) === 0) {
        // Binary string (latin-1 encoded wasm bytes starting with \0asm)
        const out = new Uint8Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
        return out;
      }
    } catch (err) {
      this.#logger.debug(
        `[rdp] source actor ${sourceActor} did not provide wasm bytes: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return null;
  }

  async fetchSourceText(sourceActor: string): Promise<string> {
    const { signal } = this.#generationAbort;
    signal.throwIfAborted();
    const resp = (await this.#client.request(
      sourceActor,
      {
        type: REQUESTS.source,
      },
      { actorLifetime: signal }
    )) as SourceResponse;
    signal.throwIfAborted();
    const src = resp.source;
    const maxChars = 8 * 1024 * 1024;
    if (typeof src === "string") {
      if (src.length > maxChars) throw new Error("source text exceeds 8 Mi characters");
      return src;
    }
    if (src && typeof src === "object") {
      const longString = src as LongStringGrip;
      if (longString.type === "longString" && longString.actor) {
        try {
          if (
            !Number.isSafeInteger(longString.length) ||
            longString.length! < 0 ||
            longString.length! > maxChars
          )
            throw new Error(`invalid source text length ${longString.length}`);
          if (longString.initial !== undefined && longString.initial.length === longString.length)
            return longString.initial;
          const sub = (await this.#client.request(
            longString.actor,
            {
              type: REQUESTS.substring,
              start: 0,
              end: longString.length,
            },
            { actorLifetime: signal }
          )) as SubstringResponse;
          signal.throwIfAborted();
          if (typeof sub.substring !== "string" || sub.substring.length !== longString.length)
            throw new Error("source text length mismatch");
          return sub.substring;
        } finally {
          if (!signal.aborted)
            await this.#client
              .request(longString.actor, { type: REQUESTS.release })
              .catch((error) =>
                this.#logger.debug(
                  `[rdp] source text release failed for ${longString.actor}: ${error}`
                )
              );
        }
      }
    }
    throw new Error(`source actor ${sourceActor} did not provide text`);
  }

  async setJsBreakpoint(sourceUrl: string, line: number): Promise<number> {
    return (await this.#breakpoints.set("js", sourceUrl, line)).line;
  }

  async removeJsBreakpoint(sourceUrl: string, line: number): Promise<void> {
    await this.#breakpoints.remove("js", sourceUrl, line);
  }

  async jsSources(): Promise<UrlSourceForm[]> {
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    const info = this.#threads.get(tids[0])!;
    try {
      const { sources } = (await this.#client.request(info.threadActor, {
        type: REQUESTS.sources,
      })) as SourcesResponse;
      const js = (sources ?? [])
        .filter((s) => s.introductionType !== "wasm")
        .filter((s) => this.#reportUsableSource(s));
      if (!this.#isCurrentThread(info)) return [];
      for (const s of js) {
        this.#rememberSource(s, info.generation);
      }
      this.#observeBreakpointSources(info, js);
      return js;
    } catch (error) {
      if (this.#closed || this.#isCurrentThread(info)) throw error;
      return [];
    }
  }

  // --- frames ---

  async frames(tid: number, start = 0, count = 1000): Promise<FrameForm[]> {
    const info = this.#info(tid);
    // A timed-out actor FIFO cannot safely accept later requests, so let the
    // client enforce the deadline and close the poisoned connection instead of
    // abandoning a still-pending request behind a local Promise.race.
    try {
      const { frames } = (await this.#client.request(
        info.threadActor,
        {
          type: REQUESTS.frames,
          start,
          count,
        },
        { timeoutMs: 5000 }
      )) as FramesResponse;
      if (!this.#isCurrentThread(info)) throw new Error("frame snapshot target retired");
      return frames ?? [];
    } catch (err) {
      if (this.#closed) throw new Error("session closed", { cause: err });
      throw err;
    }
  }

  // --- breakpoints ---

  async setWasmBreakpoint(
    sourceUrl: string,
    offset: number,
    functionRange?: WasmFunctionRange
  ): Promise<number> {
    return (await this.#breakpoints.set("wasm", sourceUrl, offset, functionRange)).line;
  }

  async removeWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    await this.#breakpoints.remove("wasm", sourceUrl, offset);
  }

  async wasmBreakpointOffsets(sourceActor: string): Promise<number[]> {
    return Object.keys(await this.#breakpoints.positions(sourceActor))
      .map(Number)
      .sort((a, b) => a - b);
  }

  #observeBreakpointSources(info: ThreadInfo, sources: SourceForm[]): void {
    void this.#breakpoints.sources(info.threadActor, sources).catch((error) => {
      if (!this.#isCurrentThread(info)) return;
      this.#logger.error(`[rdp] breakpoint replay failed for tid ${info.tid}: ${String(error)}`);
      this.close();
    });
  }

  #observeBreakpointTarget(info: ThreadInfo): void {
    void this.#breakpoints.addTarget(info.threadActor, info.generation).catch((error) => {
      if (!this.#isCurrentThread(info)) return;
      this.#logger.error(`[rdp] breakpoint replay failed for tid ${info.tid}: ${String(error)}`);
      this.close();
    });
  }

  // --- resume / step / interrupt (all-stop) ---

  #requestResume(info: ThreadInfo, limit?: "step" | "next"): void {
    this.#completedStop = undefined;
    // A requested resume invalidates the previous stop immediately. Waiting
    // for its event would let a fast peer pause publish the old paused set.
    const wasPaused = this.#pausedTids.delete(info.tid);
    this.#pausePacketByTid.delete(info.tid);
    this.#unwitnessedPausedTids.delete(info.tid);
    if (wasPaused) this.#resumingTids.add(info.tid);
    this.#client.send(info.threadActor, {
      type: REQUESTS.resume,
      ...(limit ? { resumeLimit: { type: limit } } : {}),
    });
    this.#record({
      domain: "pause",
      event: "resume-requested",
      tid: info.tid,
      actor: info.threadActor,
      generation: info.generation,
    });
  }

  /**
   * Resume all previously-paused threads (after an all-stop).
   * The top-level continue call — resumes every thread we own.
   */
  async resumeAll(): Promise<void> {
    // Resume peers before the trigger, which may immediately enter pthread_join.
    // See threaded_worker_sequence.test.mjs and docs/COMPATIBILITY.md.
    const toResume = [...this.#pausedTids].sort((a, b) => {
      if (a === this.#stoppedTid) return 1;
      if (b === this.#stoppedTid) return -1;
      return 0;
    });
    for (const tid of toResume) {
      const info = this.#threads.get(tid);
      if (!info) continue;
      this.#requestResume(info);
    }
  }

  /**
   * Single-step a specific thread (all-stop: all other threads stay paused).
   * If they are already paused (from a prior all-stop), just step this one.
   *
   * `limit` selects the RDP resume granularity: "step" advances one wasm
   * instruction (correct for wasm frames); "next" advances one JS source line
   * (correct for JIT-compiled JS frames, where "step" would jump an arbitrary
   * distance into a callee).
   */
  stepOne(tid: number, limit: "step" | "next" = "step"): void {
    const info = this.#info(tid);
    this.#requestResume(info, limit);
  }

  /** Own one execution wait through coherent all-stop. Repeated calls join it.
   * Cancellation removes listeners; a missing acknowledgement fails closed. */
  armAllStop(): StopOperation {
    if (this.#activeStop?.pending) return this.#activeStop;
    if (this.#closed) throw new Error("session closed");
    const id = this.#nextStopId++;
    const abort = new AbortController();
    let resolve!: (event: StoppedEvent) => void;
    let reject!: (error: Error) => void;
    let pending = true;
    let collecting = false;
    const witnessed = new Set<number>();
    const promise = new Promise<StoppedEvent>((r, j) => {
      resolve = r;
      reject = j;
    });
    // Legacy event subscribers may ignore the returned handle. The operation
    // still owns its rejection; callers awaiting the promise see the failure.
    void promise.catch(() => {});
    const cleanup = () => {
      for (const tid of witnessed) this.#unwatchPause(tid);
      witnessed.clear();
      this.off("paused", begin);
      this.off("target", onTarget);
      this.off("close", onClose);
      if (this.#activeStop === operation) {
        this.#activeStop = undefined;
        this.#beginStop = undefined;
      }
    };
    const cancel = (error = new Error("stop operation cancelled")) => {
      if (!pending) return;
      pending = false;
      cleanup();
      abort.abort(error);
      this.#record({
        domain: "pause",
        event: "operation-cancelled",
        detail: `stop=${id}: ${error.message}`,
      });
      reject(error);
    };
    const operation: StopOperation = {
      id,
      promise,
      cancel,
      get pending() {
        return pending;
      },
    };
    const begin = (tid: number, packet: PauseEvent) => {
      if (!pending || collecting) return;
      collecting = true;
      void this.#collectStop(tid, packet, id, abort.signal).then(
        (event) => {
          collecting = false;
          if (!pending) return;
          if (this.#closed) {
            cancel(new Error("session closed during stop"));
            return;
          }
          if (!event) {
            // A navigation retired the trigger during collection. Keep this
            // execution wait armed for the replacement's next genuine pause.
            const next = [...this.#pausedTids][0];
            if (next !== undefined) {
              const packet = this.#pausePacketByTid.get(next);
              if (packet) begin(next, packet);
            }
            return;
          }
          pending = false;
          cleanup();
          this.#stoppedTid = event.tid;
          this.#completedStop = event;
          this.#unwitnessedPausedTids.clear();
          this.#record({
            domain: "pause",
            event: "all-stopped",
            generation: event.generation,
            tid: event.tid,
            detail: `stop=${id} paused=${event.pausedTids.join(",")}`,
          });
          resolve(event);
          this.emit("stopped", event);
        },
        (error) => {
          if (!pending) return;
          cancel(error instanceof Error ? error : new Error(String(error)));
          this.#logger.error(`[rdp] all-stop coordination failed: ${String(error)}`);
          this.close();
        }
      );
    };
    const onTarget = (info: ThreadInfo) => {
      if (!witnessed.has(info.tid)) {
        witnessed.add(info.tid);
        this.#watchPause(info.tid);
      }
    };
    const onClose = () => cancel(new Error("session closed during stop"));
    this.#activeStop = operation;
    this.#beginStop = begin;
    this.on("paused", begin);
    this.on("target", onTarget);
    this.once("close", onClose);
    for (const info of this.#threads.values()) onTarget(info);
    this.#record({ domain: "pause", event: "operation-armed", detail: `stop=${id}` });
    return operation;
  }

  async #collectStop(
    tid: number,
    packet: PauseEvent,
    stopId: number,
    signal: AbortSignal
  ): Promise<StoppedEvent | undefined> {
    const trigger = this.#threads.get(tid);
    if (!trigger) return;
    const interrupted = new Set<string>();
    const complete = () =>
      !this.#isCurrentThread(trigger) ||
      [...this.#threads.values()].every((thread) => this.#pausedTids.has(thread.tid));
    const interruptRunning = () => {
      if (!this.#isCurrentThread(trigger)) return;
      for (const thread of this.#threads.values()) {
        if (
          this.#pausedTids.has(thread.tid) ||
          this.#resumingTids.has(thread.tid) ||
          interrupted.has(thread.targetActor)
        )
          continue;
        interrupted.add(thread.targetActor);
        this.#client.send(thread.threadActor, { type: REQUESTS.interrupt, when: {} });
      }
    };
    this.on("target", interruptRunning);
    this.on("lifecycle-state", interruptRunning);
    try {
      const deadline = Date.now() + 3000;
      // Register the state waiter before sending any interrupts. Newly announced
      // workers participate in the same collection and the same deadline.
      do {
        const stopped = this.#waitForState(
          complete,
          Math.max(1, deadline - Date.now()),
          `all-stop ${stopId} incomplete after 3000ms`,
          "session closed during all-stop",
          signal
        );
        void stopped.catch(() => {});
        interruptRunning();
        await stopped;
        signal.throwIfAborted();
        if (!this.#isCurrentThread(trigger)) return;
        // A target queued with the final pause joins this same deadline.
      } while (!complete());
      return {
        tid,
        pausePacket: packet,
        generation: trigger.generation,
        stopId,
        pausedTids: this.pausedTids(),
      };
    } finally {
      this.off("target", interruptRunning);
      this.off("lifecycle-state", interruptRunning);
    }
  }

  interrupt(tid: number): void {
    this.#client.send(this.#info(tid).threadActor, { type: REQUESTS.interrupt, when: {} });
  }

  /** Reject a snapshot whose stop or participating target set is no longer current. */
  assertStopped(event: StoppedEvent): void {
    if (
      this.#closed ||
      this.#completedStop !== event ||
      event.generation !== this.#activeGeneration ||
      event.pausedTids.length !== this.#threads.size ||
      event.pausedTids.some((tid) => !this.#threads.has(tid) || !this.#pausedTids.has(tid))
    )
      throw new RetiredStopError(event.stopId);
  }

  /** A newly announced target may join a still-paused stop, but never a resumed one. */
  canExtendStop(event: StoppedEvent): boolean {
    return (
      !this.#closed &&
      this.#completedStop === event &&
      event.generation === this.#activeGeneration &&
      event.pausedTids.length < this.#threads.size &&
      event.pausedTids.every((tid) => this.#threads.has(tid) && this.#pausedTids.has(tid))
    );
  }

  /** Adopt a real, unreported pause and collect its peers. Returns false when
   * every thread is running; never invents a pause packet or stop reason. */
  async adoptPausedState(): Promise<boolean> {
    const paused = [...this.#pausedTids];
    if (paused.length === 0) return false;
    // Keep the observed breakpoint, exception or interrupt reason.
    const packet = this.#pausePacketByTid.get(paused[0]);
    if (!packet) throw new Error("paused thread has no captured pause packet");
    const operation = this.armAllStop();
    this.#beginStop?.(paused[0], packet);
    await operation.promise;
    return true;
  }

  // --- console ---

  /** Evaluate JS in the page (used to drive wasm calls during tests). */
  async evaluate(text: string): Promise<void> {
    // Use the first thread with a console actor.
    const info = [...this.#threads.values()].find((t) => t.consoleActor);
    if (!info) throw new Error("no console actor");
    await this.#client.request(info.consoleActor, { type: REQUESTS.evaluateJSAsync, text });
  }

  get consoleActor(): string | null {
    return [...this.#threads.values()].find((t) => t.consoleActor)?.consoleActor ?? null;
  }

  /** Stream the page's console output (console.* and uncaught errors) to
   * `onMessage`. Listeners are started on every current and future target's
   * console actor, so worker output is included too. */
  async streamConsole(onMessage: (text: string) => void): Promise<void> {
    this.#client.on("event", (p) => {
      if (p.type === EVENTS.consoleAPICall) {
        const m = (p as ConsoleApiCallEvent).message;
        if (m) onMessage(`console.${m.level ?? "log"}: ${(m.arguments ?? []).map(grip).join(" ")}`);
      } else if (p.type === EVENTS.pageError) {
        const e = (p as PageErrorEvent).pageError;
        if (e && !e.warning) onMessage(`error: ${e.errorMessage ?? ""}`);
      }
    });
    const started = new Set<string>();
    const startFor = (actor: string): void => {
      if (!actor || started.has(actor)) return;
      started.add(actor);
      void this.#client
        .request(actor, { type: REQUESTS.startListeners, listeners: ["ConsoleAPI", "PageError"] })
        .catch((err) =>
          this.#logger.debug(
            `[rdp] could not start console listeners on ${actor}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
    };
    for (const t of this.#threads.values()) startFor(t.consoleActor);
    this.on("target", (t: ThreadInfo) => startFor(t.consoleActor));
  }

  /** Console actor of the thread that triggered the last all-stop, for
   * evaluations that must run in that thread's context.
   * Returns null if the thread has no console (avoids falling back to the
   * main-frame console, which may be paused and unresponsive). */
  get stoppedConsoleActor(): string | null {
    const actor = this.#threads.get(this.#stoppedTid)?.consoleActor;
    return actor || null;
  }

  consoleActorForThread(tid: number): string | null {
    return this.#threads.get(tid)?.consoleActor || null;
  }

  /** Fetch a frame's environment form (with the parent scope chain). */
  frameEnvironment(frameActor: string): Promise<RdpPacket> {
    return this.#client.request(frameActor, { type: REQUESTS.getEnvironment });
  }

  /** Evaluate JS in a frame's scope and resolve with the result packet.
   * @param consoleActorOverride Use a specific console actor (e.g. the stopped
   * thread's, not the main thread's — the main thread may be paused and unable
   * to service evaluations in all-stop mode).
   */
  async evaluateInFrame(
    text: string,
    frameActor: string,
    consoleActorOverride?: string
  ): Promise<RdpPacket> {
    return this.evalJS(text, frameActor, consoleActorOverride);
  }

  /** Evaluate JS and resolve with the result packet. Runs in `frameActor`'s
   * scope when given (so locals are visible), otherwise in page scope. */
  async evalJS(
    text: string,
    frameActor?: string,
    consoleActorOverride?: string
  ): Promise<RdpPacket> {
    if (this.#closed) throw new Error("session closed");
    const consoleActor =
      consoleActorOverride ?? [...this.#threads.values()].find((t) => t.consoleActor)?.consoleActor;
    if (!consoleActor) throw new Error("no console actor");
    // Firefox may send evaluationResult immediately after the acknowledgement,
    // in the same TCP chunk. Install the listener before sending the request so
    // the request promise's continuation cannot miss that result.
    // One operation owns the acknowledgement, result, deadline, and listeners.
    // A separate result promise can reject unobserved while awaiting the ack.
    return new Promise<RdpPacket>((resolve, reject) => {
      let settled = false;
      let resultID: string | undefined;
      const earlyResults = new Map<string, RdpPacket>();
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this.#client.off("event", onEvent);
        this.off("close", onClose);
        earlyResults.clear();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
      };
      const succeed = (packet: RdpPacket) => {
        if (settled) return;
        cleanup();
        resolve(packet);
      };
      const timer = setTimeout(() => {
        this.#record({
          domain: "rdp",
          event: "evaluation-timeout",
          actor: consoleActor,
          state: resultID === undefined ? "awaiting-ack" : "awaiting-result",
          detail: resultID,
        });
        fail(new Error("JavaScript evaluation timed out after 5000 ms"));
        // Without an ack, the actor FIFO still contains this request. Dropping
        // it would let a late reply satisfy a different request. After the ack,
        // only an event is missing, so the connection remains safe to use.
        if (resultID === undefined) this.close();
      }, 5000);
      const onEvent = (p: RdpPacket) => {
        if (settled || p.from !== consoleActor || p.type !== EVENTS.evaluationResult) return;
        const id = (p as { resultID?: string }).resultID;
        if (!id) return;
        if (resultID === undefined) {
          earlyResults.set(id, p);
        } else if (id === resultID) {
          succeed(p);
        }
      };
      const onClose = () => fail(new Error("session closed"));
      this.#client.on("event", onEvent);
      this.once("close", onClose);
      this.#client
        .request(consoleActor, {
          type: REQUESTS.evaluateJSAsync,
          text,
          ...(frameActor ? { frameActor } : {}),
        })
        .then((ack) => {
          if (settled) return;
          resultID = (ack as EvaluateJSAsyncAck).resultID;
          if (!resultID) {
            fail(new Error("Firefox did not return an evaluation result ID"));
            return;
          }
          const early = earlyResults.get(resultID);
          earlyResults.clear();
          if (early) succeed(early);
        })
        .catch(fail);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Do not wait for the socket's asynchronous close event. A collector must
    // distinguish terminal close from replacement before scheduling more work.
    this.#activeStop?.cancel(new Error("session closed during stop"));
    this.#breakpoints.close();
    this.#generationAbort.abort(new Error("RDP session closed"));
    this.#clearPendingDetachChecks();
    this.#record({ domain: "cleanup", event: "session-close-requested" });
    this.#client.close();
  }
}
