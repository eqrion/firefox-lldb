/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// High-level Firefox RDP session for wasm debugging.
//
// Encapsulates the validated flow against stock Firefox:
//   - getWatcher with isServerTargetSwitchingEnabled so the watcher instantiates
//     server-side targets and applies thread-config session data at creation;
//   - set observeWasm/observeAsmJS thread-config BEFORE navigation, so the
//     page's own wasm compiles with debug support;
//   - watchTargets("frame") + watchTargets("worker") + watchResources("source")
//     to track all targets (top-level frame + web workers) and their sources;
//   - per-thread setBreakpoint / frames / resume / interrupt, plus all-stop
//     coordination on any pause (interrupt all other running threads).
//
// Wasm specifics: a wasm breakpoint location is {sourceUrl, line:<byteOffset>,
// column:1}; a paused wasm frame reports where.line as the byte offset.
//
// Thread model:
//   - TID 1 = the top-level frame target (the page's JS thread).
//   - TIDs 2+ = web worker targets (emscripten pthreads pool), assigned in
//     arrival order.
//   - "Stopped" means the thread that triggered the pause; all-stop interrupts
//     the rest and waits for their acks (interrupt is reliable in < 10 ms even
//     for threads blocked in Atomics.wait).

import { RdpClient } from "./client.js";
import type { RdpPacket } from "./transport.js";
import {
  REQUESTS,
  EVENTS,
  ROOT_ACTOR,
  grip,
  hasUrl,
  type ThreadConfig,
  type TabInfo,
  type RdpTabForm,
  type ListTabsResponse,
  type GetRootResponse,
  type GetCharPrefResponse,
  type GetWatcherResponse,
  type GetThreadConfigurationActorResponse,
  type SourceForm,
  type UrlSourceForm,
  type ResourcesAvailableArrayEvent,
  type SourcesResponse,
  type SourceResponse,
  type ArrayBufferGrip,
  type ArrayBufferSliceResponse,
  type LongStringGrip,
  type SubstringResponse,
  type GetBreakpointPositionsResponse,
  type FrameForm,
  type FramesResponse,
  type PauseEvent,
  type StoppedEvent,
  type EvaluateJSAsyncAck,
  type ConsoleApiCallEvent,
  type PageErrorEvent,
} from "./protocol.js";
import { EventEmitter } from "node:events";
import type { WasmFunctionRange } from "../gdb/wasm-bytecode.js";
import { LAUNCH_TOKEN_PREF } from "./firefox.js";
import { EMPTY_WASM_MODULE, DETACH_GRACE_MS, NAVIGATE_TARGET_TIMEOUT_MS } from "./constants.js";
import { noopLogger, type Logger } from "../logging.js";
import {
  defaultModuleByteProvider,
  isWasmBinary,
  MAX_MODULE_BYTES,
  type ModuleByteProvider,
} from "./module-bytes.js";
import { requireCompatibleFirefox, type FirefoxRuntime } from "./firefox-compatibility.js";

export {
  grip,
  type TabInfo,
  type SourceForm,
  type UrlSourceForm,
  type FrameForm,
  type PauseEvent,
  type StoppedEvent,
};

// Thread configuration applied before navigation. observeWasm/observeAsmJS so the
// page's wasm compiles with debug support; pauseOnExceptions with
// ignoreCaughtExceptions so we break on uncaught wasm traps (surfacing as a
// stop) without pausing on routine caught JS exceptions.
const THREAD_CONFIG: ThreadConfig = {
  observeWasm: true,
  observeAsmJS: true,
  pauseOnExceptions: true,
  ignoreCaughtExceptions: true,
};

/**
 * Confirm the Firefox listening on port:host is the one that produced
 * expectedToken (see LAUNCH_TOKEN_PREF in rdp/firefox.ts), not an unrelated
 * instance (e.g. a stale leftover from a previous run) squatting on the same
 * port. Retries the connection itself, but fails immediately on a token
 * mismatch since retrying can't fix that.
 */
export async function verifyFirefoxLaunchToken(
  port: number,
  host: string,
  expectedToken: string,
  attempts = 80
): Promise<FirefoxRuntime> {
  let lastConnectErr: unknown;
  for (let i = 0; i < attempts; i++) {
    let client: RdpClient;
    try {
      client = await RdpClient.connect(port, host);
    } catch (err) {
      lastConnectErr = err;
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    try {
      const root = (await client.request(ROOT_ACTOR, {
        type: REQUESTS.getRoot,
      })) as GetRootResponse;
      const actor = root.preferenceActor;
      if (!actor) throw new Error("Firefox RDP root actor has no preferenceActor");
      const { value } = (await client.request(actor, {
        type: REQUESTS.getCharPref,
        value: LAUNCH_TOKEN_PREF,
      })) as GetCharPrefResponse;
      if (value !== expectedToken) {
        throw new Error(
          `RDP port ${port} is answering, but not from the Firefox instance this process just ` +
            `launched — a different (possibly stale) Firefox is listening there.`
        );
      }
      return await requireCompatibleFirefox(client);
    } finally {
      client.close();
    }
  }
  const msg = lastConnectErr instanceof Error ? lastConnectErr.message : String(lastConnectErr);
  throw new Error(`could not connect to Firefox RDP on ${port}: ${msg}`);
}

/** One-shot: connect, list tabs, disconnect. */
export async function listFirefoxTabs(port = 6080, host = "127.0.0.1"): Promise<TabInfo[]> {
  const client = await RdpClient.connect(port, host);
  try {
    const { tabs } = (await client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse;
    return toTabInfos(tabs);
  } finally {
    client.close();
  }
}

function toTabInfos(tabs: RdpTabForm[] | undefined): TabInfo[] {
  return (tabs ?? []).map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" }));
}

/**
 * Watch the tab list and enable observeWasm:true on each tab via a persistent
 * watcher. The thread config survives page navigation: any page
 * loaded in a primed tab after this call compiles wasm in debug mode, making
 * breakpoints available without a reload. Resolves when the connection closes.
 */
export async function watchAndPrimeFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void,
  logger: Logger = noopLogger,
  signal?: AbortSignal
): Promise<void> {
  const client = await RdpClient.connect(port, host, { logger });
  const abort = () => client.close();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  client.on("error", (err: Error) =>
    logger.warn(`[rdp] tab watcher transport error: ${err.message}`)
  );

  const primedActors = new Set<string>();

  const primeTab = async (tabActor: string) => {
    if (primedActors.has(tabActor)) return;
    primedActors.add(tabActor);
    try {
      const watcherR = (await client.request(tabActor, {
        type: REQUESTS.getWatcher,
        isServerTargetSwitchingEnabled: true,
      })) as GetWatcherResponse;
      const watcher = watcherR.actor;
      if (!watcher) throw new Error("no watcher actor");
      const cfg = (await client.request(watcher, {
        type: REQUESTS.getThreadConfigurationActor,
      })) as GetThreadConfigurationActorResponse;
      const configActor =
        typeof cfg.configuration === "string" ? cfg.configuration : cfg.configuration?.actor;
      if (!configActor) throw new Error("no thread config actor");
      await client.request(configActor, {
        type: REQUESTS.updateConfiguration,
        configuration: THREAD_CONFIG,
      });
      // Do NOT call watchTargets here. With two connections both subscribed via
      // watchTargets, Firefox routes paused events to whichever connection called
      // watchTargets first (the watcher). The launcher's armAllStop never fires
      // and EventFuture.finish hangs waiting for the trap's paused event.
      // The launcher's own RdpWasmSession calls watchTargets in #init(), making
      // it the sole subscriber and ensuring it receives all thread events.
    } catch (err) {
      // Tab may have disappeared; ignore and let the next query re-prime it.
      primedActors.delete(tabActor);
      logger.debug(
        `[rdp] could not prime tab ${tabActor}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const query = async () => {
    const { tabs } = (await client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse;
    const tabList = tabs ?? [];
    onTabs(toTabInfos(tabList));
    for (const t of tabList) void primeTab(t.actor);
  };

  client.on("event", (p) => {
    if (p.type === EVENTS.tabListChanged || p.type === EVENTS.tabNavigated)
      void query().catch((err) =>
        logger.debug(
          `[rdp] tab refresh failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  });

  try {
    await requireCompatibleFirefox(client, logger);
    await query();
    const startupRetry = setTimeout(
      () =>
        void query().catch((err) =>
          logger.debug(
            `[rdp] startup tab query failed: ${err instanceof Error ? err.message : String(err)}`
          )
        ),
      2000
    );

    await new Promise<void>((resolve) =>
      client.on("close", () => {
        clearTimeout(startupRetry);
        resolve();
      })
    );
  } catch (err) {
    client.close();
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

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

export class RdpWasmSession extends EventEmitter {
  #client: RdpClient;
  #logger: Logger;
  #moduleByteProvider: ModuleByteProvider;
  #tabActor!: string;
  #watcher!: string;

  // tid -> ThreadInfo (including the top-level frame target)
  #threads = new Map<number, ThreadInfo>();
  #nextTid = 1;
  #nextGeneration = 1;
  #activeGeneration = 0;

  // tid of the thread that triggered the most recent all-stop pause
  #stoppedTid = 1;

  // tids that we interrupted during all-stop (to be resumed on next continue)
  // tids that are currently paused (breakpoint, step, or interrupt)
  #pausedTids = new Set<number>();
  // Subset of #pausedTids that paused with no armAllStop listener catching
  // it (see the EVENTS.paused case). Cleared once #allStop reports a stop
  // that accounts for them, or the tid resumes.
  #unwitnessedPausedTids = new Set<number>();
  // Real pause packet per currently-paused tid, mirroring #pausedTids's
  // lifecycle exactly (same add/delete sites). Lets adoptPausedState()
  // report the actual why.type instead of a synthetic empty packet that
  // always defaults to "breakpoint" downstream in RdpDebuggee.
  #pausePacketByTid = new Map<number, PauseEvent>();
  // Explicit pause-coordination ownership. EventEmitter listener counts are
  // observable plumbing, not debugger state: diagnostic listeners and leaked
  // callbacks must not change whether a pause is considered witnessed.
  #pauseWitnessCountByTid = new Map<number, number>();

  // breakpoints buffered so new workers inherit them
  #breakpoints = new Map<string, Set<number>>(); // sourceUrl -> set of offsets
  // Function-body bounds for breakpoint requests whose module bytecode was
  // available. Used to keep nearest-position snapping inside the same body.
  #breakpointRangeByUrl = new Map<string, Map<number, WasmFunctionRange>>();
  // Exact RDP location selected for each LLDB-requested wasm PC. Firefox only
  // accepts valid instruction boundaries, so insertion may snap the PC.
  #snappedBreakpointByUrl = new Map<string, Map<number, number>>();

  #wasmActorByUrl = new Map<string, { actor: string; generation: number }>();
  #breakpointPositionCache = new Map<string, Promise<number[]>>(); // actor -> positions
  #jsActorByUrl = new Map<string, { actor: string; generation: number }>();
  // Reverse of the two maps above (wasm + JS actors share one namespace).
  // The single owner of actor->url lookups — RdpDebuggee reads it via
  // urlForSourceActor() instead of keeping its own copy.
  #sourceUrlByActor = new Map<string, { url: string; generation: number }>();
  // Actors already reported as URL-less, so a busy page warns once each.
  #warnedUrllessActors = new Set<string>();

  // Pending "is this top-level destroy a real close?" checks (see DETACH_GRACE_MS).
  #pendingDetachChecks = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  #clearPendingDetachChecks(): void {
    for (const timer of this.#pendingDetachChecks) clearTimeout(timer);
    this.#pendingDetachChecks.clear();
  }

  // tid to hand to the next top-level target, reused from the one a
  // navigation just destroyed rather than minted fresh. LLDB has no RSP
  // mechanism to learn "tid N is gone, thread state referencing it is
  // stale" (gdbstub has no thread-exited/exec stop reason) — its own
  // breakpoint step-off dance (remove bp, single-step the thread it
  // believes is current, re-add) keeps addressing the old tid regardless of
  // what we tell it. Keeping the number stable across the swap means that
  // stale-looking reference is actually still valid, pointed at the new
  // page's thread.
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
    // A replacement top-level target can already own the same stable tid.
    // Only delete the map entry if it still describes this actor.
    if (this.#threads.get(info.tid)?.targetActor === info.targetActor) {
      this.#threads.delete(info.tid);
    }
    this.#pausedTids.delete(info.tid);
    this.#unwitnessedPausedTids.delete(info.tid);
    this.#pausePacketByTid.delete(info.tid);
    this.emit(`target-destroyed:${info.targetActor}`, info);
  }

  #retireGeneration(generation: number): void {
    for (const info of [...this.#threads.values()]) {
      if (info.generation === generation) this.#removeThread(info);
    }
  }

  // Source actors are scoped to an RDP connection and become invalid whenever
  // the top-level target goes away — whether that's a navigate() we drove or
  // one the page triggered on its own (reload, self-redirect, Fission
  // process-swap). Stale entries here cause breakpoint-position queries to
  // hit dead actors (session.ts's #snapOffset) instead of just falling back
  // gracefully.
  #invalidateActorCaches(): void {
    this.#jsActorByUrl.clear();
    this.#wasmActorByUrl.clear();
    this.#breakpointPositionCache.clear();
    this.#sourceUrlByActor.clear();
  }

  // Fires whenever the top-level target is gone — a navigate() we drove, or
  // the page navigating on its own (reload, link click, location assignment).
  // Distinct from "detached": that one is grace-gated and means the tab is
  // really closed, while this fires unconditionally so a live LLDB
  // attachment (RdpDebuggee) can re-sync (refetch bytecode, force a re-sync
  // stop) even when a Fission process-swap replacement is on its way.
  #onTopLevelGone(info?: ThreadInfo): void {
    this.#invalidateActorCaches();
    this.emit("navigated", info);
  }

  private constructor(client: RdpClient, logger: Logger, moduleByteProvider: ModuleByteProvider) {
    super();
    this.#client = client;
    this.#logger = logger;
    this.#moduleByteProvider = moduleByteProvider;
    // Forward transport close so consumers can unblock pending promises.
    client.on("close", () => {
      this.#closed = true;
      this.#clearPendingDetachChecks();
      this.emit("close");
    });
    client.on("error", (err: Error) => this.#logger.error(`[rdp] transport error: ${err.message}`));
  }

  // --- public accessors ---

  get stoppedTid(): number {
    return this.#stoppedTid;
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

  /** Wait until watchTargets has announced the tab's initial top-level target.
   * The watchTargets request can resolve before its target-available event is
   * delivered. Callers that navigate immediately must not treat that late
   * initial about:blank target as the replacement created by navigation. */
  waitForTopLevelTarget(timeoutMs = 10_000): Promise<void> {
    if (this.topLevelTid() !== undefined) return Promise.resolve();
    if (this.#closed) {
      return Promise.reject(
        new Error("session closed while waiting for the initial top-level target")
      );
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("target", onTarget);
        this.off("close", onClose);
      };
      const onTarget = (info: ThreadInfo) => {
        if (!info.isTopLevel) return;
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("session closed while waiting for the initial top-level target"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no initial top-level target within ${timeoutMs}ms`));
      }, timeoutMs);
      this.on("target", onTarget);
      this.on("close", onClose);
    });
  }

  /** Connect, enable wasm observation, and start watching targets. */
  static async start(
    port = 6080,
    host = "127.0.0.1",
    tabActor?: string,
    logger: Logger = noopLogger,
    moduleByteProvider: ModuleByteProvider = defaultModuleByteProvider
  ): Promise<RdpWasmSession> {
    const client = await RdpClient.connect(port, host, { logger });
    const session = new RdpWasmSession(client, logger, moduleByteProvider);
    try {
      await session.#init(tabActor);
      return session;
    } catch (err) {
      // Initialization is transactional: callers commonly retry while Firefox
      // is still starting, so retaining the failed socket would leak one RDP
      // connection per attempt.
      client.close();
      throw err;
    }
  }

  async #init(tabActor?: string): Promise<void> {
    await requireCompatibleFirefox(this.#client, this.#logger);
    const { tabs } = (await this.#client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse & { tabs?: (RdpTabForm & { selected?: boolean })[] };
    const tab =
      (tabActor ? tabs?.find((t) => t.actor === tabActor) : undefined) ??
      tabs?.find((t) => t.selected) ??
      tabs?.[0];
    if (!tab) throw new Error("no Firefox tab found (Firefox may still be starting)");
    this.#tabActor = tab.actor;

    const watcherResp = (await this.#client.request(this.#tabActor, {
      type: REQUESTS.getWatcher,
      isServerTargetSwitchingEnabled: true,
    })) as GetWatcherResponse;
    const watcher = watcherResp.actor;
    if (!watcher) throw new Error("Firefox did not return a watcher actor");
    this.#watcher = watcher;

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

    this.#client.on("event", (p) => this.#onEvent(p));
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchTargets,
      targetType: "frame",
    });
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchTargets,
      targetType: "worker",
    });
    await this.#client.request(this.#watcher, {
      type: REQUESTS.watchResources,
      resourceTypes: ["source"],
    });
  }

  #onEvent(p: RdpPacket): void {
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
        if (!targetActor || !threadActor) break;

        // Check if this actor is already known (re-announce after navigation).
        const existing = [...this.#threads.values()].find((t) => t.targetActor === targetActor);
        if (existing) break;

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
          // Workers can be announced in the destroy/available gap. Adopt them
          // into the new incarnation once its top-level target identifies it.
          for (const thread of this.#threads.values()) {
            if (thread.generation === 0) thread.generation = generation;
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
        this.#threads.set(tid, info);

        // Apply any buffered breakpoints to the new worker.
        void this.#applyBreakpoints(info).catch((err) =>
          this.#logger.warn(
            `[rdp] could not apply buffered breakpoints to tid ${info.tid}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );

        this.emit("target", info);
        break;
      }
      case EVENTS.targetDestroyedForm: {
        // Unlike target-available-form, this payload carries the window/frame
        // target actor but not the thread actor — match on that instead, or a
        // destroyed process-swap target (e.g. Fission reloading the page into
        // a new process right after the initial navigation) never gets pruned
        // from #threads and a later all-stop interrupt hangs on the dead tid.
        const target = p.target as { actor?: string };
        const targetActor = target?.actor;
        if (!targetActor) break;
        const entry = [...this.#threads.entries()].find(([, t]) => t.targetActor === targetActor);
        if (entry) {
          const [, info] = entry;
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
                this.emit("detached", info);
              }
            }, DETACH_GRACE_MS);
            this.#pendingDetachChecks.add(timer);
          } else {
            this.#removeThread(info);
          }
        }
        break;
      }
      case EVENTS.resourcesAvailableArray: {
        // Current Firefox batches watched resources. Worker SourceActor ids
        // are thread-local, so retain every actor -> URL mapping; otherwise a
        // stopped worker frame is mistaken for a brand-new module whose name
        // is the opaque actor id, and gdbstub aborts during frame_to_pc.
        const groups = (p as ResourcesAvailableArrayEvent).array;
        if (!groups) break;
        for (const group of groups) {
          if (!Array.isArray(group) || group[0] !== "source" || !Array.isArray(group[1])) continue;
          for (const source of group[1] as SourceForm[]) {
            if (!source.actor || !this.#reportUsableSource(source)) continue;
            const generation = this.#activeGeneration;
            if (generation === 0) continue;
            this.#sourceUrlByActor.set(source.actor, { url: source.url, generation });
            if (source.introductionType === "wasm") {
              this.#wasmActorByUrl.set(source.url, { actor: source.actor, generation });
            } else {
              this.#jsActorByUrl.set(source.url, { actor: source.actor, generation });
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
        this.#pausePacketByTid.set(tid, p as PauseEvent);
        // No all-stop coordinator owns this pause right now — e.g. a
        // newly-navigated page's
        // buffered breakpoint fires before the next Debuggee.continue arms
        // the all-stop machinery. Remember it as unwitnessed so the next
        // continue adopts it instead of blindly resuming past it (see
        // hasUnwitnessedPause() and its caller in rdp-debuggee.ts).
        if ((this.#pauseWitnessCountByTid.get(tid) ?? 0) === 0) {
          this.#unwitnessedPausedTids.add(tid);
        }
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
          const [tid] = entry;
          this.#pausedTids.delete(tid);
          this.#pausePacketByTid.delete(tid);
          this.#unwitnessedPausedTids.delete(tid);
        }
        break;
      }
    }
  }

  /** Navigate the tab; resolves once a replacement top-level generation arrives. */
  async navigate(url: string): Promise<void> {
    // Do not mutate live target state before Firefox accepts the request. The
    // watcher events perform the generation swap transactionally; if navigateTo
    // is rejected, the existing generation remains usable.
    const startingGeneration = this.topLevelGeneration();
    const cleanupRef = { fn: null as (() => void) | null };
    const target = new Promise<void>((resolve, reject) => {
      // navigateTo has already reported the load complete by the time this is
      // awaited, so a replacement generation is due immediately. Bound the wait
      // anyway: a Fission process swap can destroy and recreate the top-level
      // target around this exact moment (see DETACH_GRACE_MS), and a swap missed
      // in that window would otherwise hang the caller with no error to retry on.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        cleanupRef.fn = null;
        clearTimeout(timer);
        this.off("target", onTarget);
        this.off("close", onClose);
      };
      cleanupRef.fn = cleanup;
      // Do not require the URL to match: redirects routinely change it. But
      // Firefox can announce an intermediate about:blank replacement before
      // the requested page's real target arrives. Returning on that target
      // lets attach-time primeStop pause the blank document and strand the
      // navigation there indefinitely.
      const onTarget = (t: ThreadInfo) => {
        const transientBlank = url !== "about:blank" && t.url === "about:blank";
        if (t.isTopLevel && t.generation !== startingGeneration && !transientBlank) {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("session closed during navigate"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no replacement top-level target within ${NAVIGATE_TARGET_TIMEOUT_MS}ms`));
      }, NAVIGATE_TARGET_TIMEOUT_MS);
      this.on("target", onTarget);
      this.on("close", onClose);
    });
    // A pause during the load leaves navigateTo unanswerable: with
    // pauseOnExceptions armed, an uncaught exception in a loading script stops
    // the thread, the load event never fires, and waitForLoad holds the reply.
    // That request going unanswered would take the whole connection down at the
    // client's request timeout (replies are FIFO, so it closes rather than risk
    // a late reply landing on the next request). Resume past such a pause so the
    // load can finish; the page is only mid-load, and the attach sequence makes
    // its own stop afterwards (RdpDebuggee.primeStop).
    const onPausedDuringLoad = (tid: number) => {
      this.#logger.debug(`[rdp] resuming tid ${tid} paused during navigation to ${url}`);
      const info = this.#threads.get(tid);
      if (info) this.#client.send(info.threadActor, { type: REQUESTS.resume });
    };
    this.on("paused", onPausedDuringLoad);
    try {
      await this.#client.request(this.#tabActor, {
        type: REQUESTS.navigateTo,
        url,
        waitForLoad: true,
      });
      await target;
    } catch (err) {
      cleanupRef.fn?.();
      throw err;
    } finally {
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
    return this.#threads.get(info.tid)?.targetActor === info.targetActor;
  }

  /** Send a raw request to an actor (escape hatch for actor-specific packets). */
  request(actor: string, packet: Record<string, unknown>): Promise<RdpPacket> {
    return this.#client.request(actor, packet);
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
      this.#wasmActorByUrl.set(s.url, { actor: s.actor, generation: info.generation });
      this.#sourceUrlByActor.set(s.actor, { url: s.url, generation: info.generation });
    }
    return wasm;
  }

  // A URL-less source cannot be addressed: Firefox resolves breakpoints by
  // `location.sourceUrl`, and our buffering maps are URL-keyed so a new worker
  // thread inherits them. Drop it, once per actor.
  //
  // Firefox reports url:null routinely for eval/new Function/debugger-eval
  // scripts, which nobody expects to debug, so those stay at debug level. A
  // URL-less *wasm* module is different: it silently will not be debuggable,
  // and the user needs to be told why.
  #reportUsableSource(s: SourceForm): s is UrlSourceForm {
    if (hasUrl(s)) return true;
    if (!this.#warnedUrllessActors.has(s.actor)) {
      this.#warnedUrllessActors.add(s.actor);
      const msg =
        `[rdp] ignoring ${s.introductionType ?? "unknown"} source ${s.actor}: ` +
        `Firefox reports no URL for it, and a breakpoint can only be addressed by URL`;
      if (s.introductionType === "wasm") this.#logger.warn(msg);
      else this.#logger.debug(msg);
    }
    return false;
  }

  /** Wasm sources deduped by URL across all known threads. */
  async wasmSources(): Promise<UrlSourceForm[]> {
    // Use the top-level thread (lowest tid, always has the full source list).
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    try {
      return await this.wasmSourcesForTid(tids[0]);
    } catch {
      // Try any other thread.
      for (const tid of tids.slice(1)) {
        try {
          return await this.wasmSourcesForTid(tid);
        } catch {}
      }
      return [];
    }
  }

  /** URL for a wasm or JS source actor, if known (populated by wasmSourcesForTid/jsSources). */
  urlForSourceActor(actor: string): string | undefined {
    const entry = this.#sourceUrlByActor.get(actor);
    return entry?.generation === this.#activeGeneration ? entry.url : undefined;
  }

  async fetchModuleBytes(url: string): Promise<Uint8Array> {
    // Module.bytecode's WIT signature has no error case, so a throw here is
    // re-thrown uncaught inside the gdbstub worker and takes the whole session
    // with it. Degrade like the unavailable-bytes path below instead.
    if (typeof url !== "string") {
      this.#logger.error(`[rdp] module bytes requested for a source with no URL (${url})`);
      return EMPTY_WASM_MODULE;
    }
    const actorEntry = this.#wasmActorByUrl.get(url);
    const actor = actorEntry?.generation === this.#activeGeneration ? actorEntry.actor : undefined;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        return await this.#moduleByteProvider.fetch(url);
      } catch (e) {
        // A Node-side fetch may lack the page's credentials, client cert, or
        // cache context. Fall back to Firefox's source actor, which exposes the
        // exact browser-loaded ArrayBuffer.
        this.#logger.debug(
          `[rdp] out-of-band module fetch failed for ${url}; trying browser source: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
    if (actor) {
      const bytes = await this.#fetchWasmBytesFromActor(actor);
      if (bytes && isWasmBinary(bytes)) return bytes;
    }
    // Module.bytecode's WIT signature has no error case. Return a minimal valid
    // wasm binary so one unavailable module does not trap the entire component.
    this.#logger.error(`[rdp] could not acquire valid module bytes for ${url}`);
    return EMPTY_WASM_MODULE;
  }

  /** Try to fetch raw wasm bytes from a source actor via RDP. */
  async #fetchWasmBytesFromActor(sourceActor: string): Promise<Uint8Array | null> {
    try {
      const resp = (await this.#client.request(sourceActor, {
        type: REQUESTS.source,
      })) as SourceResponse;
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
          sliced = (await this.#client.request(grip.actor, {
            type: REQUESTS.slice,
            start: 0,
            count: grip.length,
          })) as ArrayBufferSliceResponse;
        } finally {
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
    const resp = (await this.#client.request(sourceActor, {
      type: REQUESTS.source,
    })) as SourceResponse;
    const src = resp.source;
    if (typeof src === "string") return src;
    if (src && typeof src === "object") {
      const longString = src as LongStringGrip;
      if (longString.type === "longString" && longString.actor && longString.length !== undefined) {
        if (longString.initial !== undefined && longString.initial.length === longString.length) {
          return longString.initial;
        }
        const sub = (await this.#client.request(longString.actor, {
          type: REQUESTS.substring,
          start: 0,
          end: longString.length,
        })) as SubstringResponse;
        return sub.substring ?? "";
      }
    }
    return "";
  }

  async setJsBreakpoint(sourceUrl: string, line: number): Promise<void> {
    const loc = await this.#snapJsLocation(sourceUrl, line);
    await Promise.all(
      [...this.#threads.values()].map((t) =>
        this.#client
          .request(t.threadActor, {
            type: REQUESTS.setBreakpoint,
            location: { sourceUrl, line: loc.line, column: loc.column },
            options: {},
          })
          .catch(() => {})
      )
    );
  }

  async removeJsBreakpoint(sourceUrl: string, line: number): Promise<void> {
    const loc = await this.#snapJsLocation(sourceUrl, line);
    await Promise.all(
      [...this.#threads.values()].map((t) =>
        this.#client
          .request(t.threadActor, {
            type: REQUESTS.removeBreakpoint,
            location: { sourceUrl, line: loc.line, column: loc.column },
          })
          .catch(() => {})
      )
    );
  }

  /**
   * Snap a JS source line to a real breakpoint position. Firefox only fires a
   * breakpoint set at a valid (line, column) entry point; an arbitrary column
   * binds to nothing and never hits. Pick the nearest line with positions
   * (preferring forward, so the fired line stays within the component's
   * pre-snap breakpoint-match tolerance) and its first column.
   */
  async #snapJsLocation(
    sourceUrl: string,
    line: number
  ): Promise<{ line: number; column?: number }> {
    const actorEntry = this.#jsActorByUrl.get(sourceUrl);
    const actor = actorEntry?.generation === this.#activeGeneration ? actorEntry.actor : undefined;
    if (!actor) return { line };
    let positions: Record<string, number[]>;
    try {
      const resp = (await this.#client.request(actor, {
        type: REQUESTS.getBreakpointPositionsCompressed,
        query: { start: { line: 0 }, end: { line: 1e7 } },
      })) as GetBreakpointPositionsResponse;
      positions = resp.positions ?? {};
    } catch {
      return { line };
    }
    const lines = Object.keys(positions)
      .map(Number)
      .sort((a, b) => a - b);
    if (!lines.length) return { line };
    const snLine = lines.find((l) => l >= line) ?? lines[lines.length - 1];
    const cols = (positions[String(snLine)] ?? []).slice().sort((a, b) => a - b);
    // cols[0] is undefined if positions returns a line with an empty column list.
    return cols.length > 0 ? { line: snLine, column: cols[0] } : { line: snLine };
  }

  async jsSources(): Promise<UrlSourceForm[]> {
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    try {
      const info = this.#threads.get(tids[0])!;
      const { sources } = (await this.#client.request(info.threadActor, {
        type: REQUESTS.sources,
      })) as SourcesResponse;
      const js = (sources ?? [])
        .filter((s) => s.introductionType !== "wasm")
        .filter((s) => this.#reportUsableSource(s));
      if (!this.#isCurrentThread(info)) return [];
      for (const s of js) {
        this.#jsActorByUrl.set(s.url, { actor: s.actor, generation: info.generation });
        this.#sourceUrlByActor.set(s.actor, { url: s.url, generation: info.generation });
      }
      return js;
    } catch {
      return [];
    }
  }

  // --- frames ---

  async frames(tid: number, start = 0, count = 1000): Promise<FrameForm[]> {
    // A timed-out actor FIFO cannot safely accept later requests, so let the
    // client enforce the deadline and close the poisoned connection instead of
    // abandoning a still-pending request behind a local Promise.race.
    try {
      const { frames } = (await this.#client.request(
        this.#info(tid).threadActor,
        {
          type: REQUESTS.frames,
          start,
          count,
        },
        { timeoutMs: 5000 }
      )) as FramesResponse;
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
    // Buffer so new workers inherit it.
    if (!this.#breakpoints.has(sourceUrl)) this.#breakpoints.set(sourceUrl, new Set());
    this.#breakpoints.get(sourceUrl)!.add(offset);
    if (functionRange) {
      let ranges = this.#breakpointRangeByUrl.get(sourceUrl);
      if (!ranges) {
        ranges = new Map();
        this.#breakpointRangeByUrl.set(sourceUrl, ranges);
      }
      ranges.set(offset, functionRange);
    }

    const snappedOffset = await this.#snapOffset(sourceUrl, offset, functionRange);
    let snappedByOffset = this.#snappedBreakpointByUrl.get(sourceUrl);
    if (!snappedByOffset) {
      snappedByOffset = new Map();
      this.#snappedBreakpointByUrl.set(sourceUrl, snappedByOffset);
    }
    snappedByOffset.set(offset, snappedOffset);
    await Promise.all(
      [...this.#threads.values()].map(
        (t) =>
          this.#client
            .request(t.threadActor, {
              type: REQUESTS.setBreakpoint,
              location: { sourceUrl, line: snappedOffset, column: 1 },
              options: {},
            })
            .catch(() => {}) // ignore stale actors
      )
    );
    return snappedOffset;
  }

  async removeWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    this.#breakpoints.get(sourceUrl)?.delete(offset);
    const ranges = this.#breakpointRangeByUrl.get(sourceUrl);
    ranges?.delete(offset);
    if (ranges?.size === 0) this.#breakpointRangeByUrl.delete(sourceUrl);
    const snappedByOffset = this.#snappedBreakpointByUrl.get(sourceUrl);
    // Re-snapping after an actor/cache change can choose a different offset
    // and leave the original Firefox breakpoint armed.
    const snappedOffset =
      snappedByOffset?.get(offset) ?? (await this.#snapOffset(sourceUrl, offset));
    snappedByOffset?.delete(offset);
    if (snappedByOffset?.size === 0) this.#snappedBreakpointByUrl.delete(sourceUrl);
    await Promise.all(
      [...this.#threads.values()].map((t) =>
        this.#client
          .request(t.threadActor, {
            type: REQUESTS.removeBreakpoint,
            location: { sourceUrl, line: snappedOffset, column: 1 },
          })
          .catch(() => {})
      )
    );
  }

  async wasmBreakpointOffsets(sourceActor: string): Promise<number[]> {
    // Cache per actor: for large modules the RDP round-trip for all positions
    // can be expensive. For a wasm source the compressed response is
    // { <wasm byte offset>: [1] }; the keys, not the column arrays, are the
    // valid Z0 locations. Subsequent packets reuse the same list.
    let p = this.#breakpointPositionCache.get(sourceActor);
    if (!p) {
      p = (async () => {
        const { positions } = (await this.#client.request(sourceActor, {
          type: REQUESTS.getBreakpointPositionsCompressed,
          query: { start: { line: 0 }, end: { line: 1e7 } },
        })) as GetBreakpointPositionsResponse;
        return Object.keys(positions ?? {})
          .map(Number)
          .filter((n) => !Number.isNaN(n))
          .sort((a, b) => a - b);
      })();
      this.#breakpointPositionCache.set(sourceActor, p);
    }
    return p;
  }

  async #snapOffset(
    sourceUrl: string,
    offset: number,
    functionRange?: WasmFunctionRange
  ): Promise<number> {
    const actorEntry = this.#wasmActorByUrl.get(sourceUrl);
    const actor = actorEntry?.generation === this.#activeGeneration ? actorEntry.actor : undefined;
    if (!actor) return offset;
    const positions = await this.wasmBreakpointOffsets(actor).catch((): number[] => []);
    if (!positions.length || positions.includes(offset)) return offset;
    const candidates = functionRange
      ? positions.filter((p) => p >= functionRange.start && p < functionRange.end)
      : positions;
    if (!candidates.length) return offset;
    // Keep the established nearest-position behavior for source breakpoints,
    // but never let it escape the containing function. A function low_pc can
    // sit in its encoded body header; without the range constraint its closest
    // position may be the preceding function's final opcode.
    return candidates.reduce(
      (best, p) => (Math.abs(p - offset) < Math.abs(best - offset) ? p : best),
      candidates[0]
    );
  }

  /** Apply all buffered breakpoints to a newly-arrived thread. */
  async #applyBreakpoints(info: ThreadInfo): Promise<void> {
    if (!this.#isCurrentThread(info)) return;
    // A brand new target (post-navigation, or a fresh worker) hasn't
    // necessarily discovered its wasm sources yet — the page's script needs
    // a moment to load and instantiate the module. #wasmActorByUrl starts
    // out empty for it, and #snapOffset falls back to the un-snapped offset
    // when it can't find an actor; Firefox silently never fires a wasm
    // breakpoint set at a position that isn't a valid instruction boundary,
    // so every buffered breakpoint would silently stop working on the new
    // target. Poll briefly for the sources to appear before snapping.
    if (this.#breakpoints.size > 0) {
      for (let i = 0; i < 10; i++) {
        if (!this.#isCurrentThread(info)) return;
        // Cap each attempt: if the actor never replies (a stale/dead thread,
        // or simply no wasm on this target), this poll must still progress
        // and eventually give up rather than hang on the very first await.
        const sources = await Promise.race([
          this.#wasmSourcesForInfo(info).catch((): SourceForm[] => []),
          new Promise<SourceForm[]>((resolve) => setTimeout(() => resolve([]), 200)),
        ]);
        if (sources.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    for (const [sourceUrl, offsets] of this.#breakpoints) {
      for (const offset of offsets) {
        if (!this.#isCurrentThread(info)) return;
        const range = this.#breakpointRangeByUrl.get(sourceUrl)?.get(offset);
        const snapped = await this.#snapOffset(sourceUrl, offset, range);
        let snappedByOffset = this.#snappedBreakpointByUrl.get(sourceUrl);
        if (!snappedByOffset) {
          snappedByOffset = new Map();
          this.#snappedBreakpointByUrl.set(sourceUrl, snappedByOffset);
        }
        snappedByOffset.set(offset, snapped);
        if (!this.#isCurrentThread(info)) return;
        await this.#client
          .request(info.threadActor, {
            type: REQUESTS.setBreakpoint,
            location: { sourceUrl, line: snapped, column: 1 },
            options: {},
          })
          .catch(() => {});
      }
    }
  }

  // --- resume / step / interrupt (all-stop) ---

  /**
   * Resume all previously-paused threads (after an all-stop).
   * The top-level continue call — resumes every thread we own.
   */
  async resumeAll(): Promise<void> {
    // Release the threads interrupted by #allStop before the thread that
    // originally stopped. In a pthread program the stopped main thread can
    // enter pthread_join as soon as it resumes; Firefox may then stop
    // servicing worker-thread resume packets that were queued behind it.
    // Sending the triggering thread last ensures every worker is runnable
    // before the main thread can wait for it. In particular, this avoids the
    // repeated all-stop pthread_join deadlock from issue #7.
    const toResume = [...this.#pausedTids].sort((a, b) => {
      if (a === this.#stoppedTid) return 1;
      if (b === this.#stoppedTid) return -1;
      return 0;
    });
    for (const tid of toResume) {
      const info = this.#threads.get(tid);
      if (!info) continue;
      this.#client.send(info.threadActor, { type: REQUESTS.resume });
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
    this.#client.send(info.threadActor, { type: REQUESTS.resume, resumeLimit: { type: limit } });
  }

  /**
   * Wait for ANY thread to pause, then interrupt all others and wait for
   * their acks. Emits "stopped" with the triggering tid once all threads are
   * paused. This is the all-stop implementation.
   */
  armAllStop(): void {
    let fired = false;
    const perTidHandlers = new Map<number, (p: PauseEvent) => void>();
    let onNewTarget: ((info: ThreadInfo) => void) | null = null;

    const cleanup = () => {
      for (const [tid, h] of perTidHandlers) {
        this.off(`paused:${tid}`, h);
        this.#unwatchPause(tid);
      }
      perTidHandlers.clear();
      if (onNewTarget) {
        this.off("target", onNewTarget);
        onNewTarget = null;
      }
      this.off("close", onClose);
    };

    const onPaused = (tid: number, packet: PauseEvent) => {
      if (fired) return;
      fired = true;
      cleanup();
      void this.#allStop(tid, packet).catch((err) => {
        this.#logger.error(
          `[rdp] all-stop coordination failed: ${err instanceof Error ? err.message : String(err)}`
        );
        this.close();
      });
    };

    // If the session closes before any thread pauses, clean up the listeners
    // so they don't linger in the session's EventEmitter.
    const onClose = () => {
      if (fired) return;
      fired = true;
      cleanup();
    };

    const addTid = (tid: number) => {
      if (fired) return;
      // A navigation reuses the old top-level tid for the replacement target.
      // The existing event listener is keyed by tid rather than actor, so it
      // already covers the replacement. Installing another one would overwrite
      // the Map entry without removing the first listener; that orphan would
      // leak until session close and could invoke stale coordination logic on
      // later pauses.
      if (perTidHandlers.has(tid)) return;
      const h = (p: PauseEvent) => onPaused(tid, p);
      perTidHandlers.set(tid, h);
      this.#watchPause(tid);
      this.on(`paused:${tid}`, h);
    };

    onNewTarget = (info: ThreadInfo) => addTid(info.tid);
    this.on("target", onNewTarget);
    this.once("close", onClose);

    for (const tid of this.#threads.keys()) addTid(tid);
  }

  async #allStop(stoppedTid: number, packet: PauseEvent): Promise<void> {
    this.#stoppedTid = stoppedTid;

    // Interrupt all other running threads and wait for their pauses.
    const others = [...this.#threads.keys()].filter(
      (tid) => tid !== stoppedTid && !this.#pausedTids.has(tid)
    );

    await Promise.all(
      others.map(async (tid) => {
        const info = this.#threads.get(tid);
        if (!info) return;
        // Send interrupt and wait for the paused event. Interrupt is normally
        // < 10 ms, but cap at 3 s for threads that may not be interruptible
        // (e.g. a futex-blocked worker whose JS loop is frozen). Also resolve
        // immediately if the session closes so shutdown isn't delayed 3 s.
        const paused = new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.off(`paused:${tid}`, onPaused);
            this.off(`target-destroyed:${info.targetActor}`, onDestroyed);
            this.off("close", onClose);
            this.#unwatchPause(tid);
            resolve();
          };
          const timer = setTimeout(done, 3000);
          const onPaused = done;
          const onDestroyed = done;
          const onClose = done;
          this.#watchPause(tid);
          this.once(`paused:${tid}`, onPaused);
          this.once(`target-destroyed:${info.targetActor}`, onDestroyed);
          this.once("close", onClose);
        });
        this.#client.send(info.threadActor, { type: REQUESTS.interrupt, when: {} });
        await paused;
      })
    );

    // Every currently-paused tid is now accounted for by this reported stop
    // (the stoppedTid, plus whichever others we just interrupted), whether
    // this ran via armAllStop's normal flow or adoptPausedState() surfacing
    // one that was left unwitnessed.
    this.#unwitnessedPausedTids.clear();
    this.emit("stopped", { tid: stoppedTid, pausePacket: packet } as StoppedEvent);
  }

  interrupt(tid: number): void {
    this.#client.send(this.#info(tid).threadActor, { type: REQUESTS.interrupt, when: {} });
  }

  /**
   * If any thread is already paused (e.g. pauseOnExceptions fired during page
   * load before primeStop had a chance to arm its listener), adopt the first
   * paused thread as the stopped thread and interrupt any others. Returns true
   * if a paused thread was found; false if all threads are running.
   *
   * Sending interrupt to an already-paused thread returns an alreadyPaused
   * error reply (not a paused event), so armAllStop would silently lose it
   * and primeStop would hang. This method sidesteps that by running #allStop
   * directly when the paused state is already known.
   */
  async adoptPausedState(): Promise<boolean> {
    const paused = [...this.#pausedTids];
    if (paused.length === 0) return false;
    // Report the real pause packet (why.type etc.) if we captured one for
    // this tid, rather than a synthetic empty one that always reads as a
    // generic breakpoint downstream — this tid was genuinely paused, just
    // not by us, so its real cause (trap/exception/breakpoint) is known.
    const packet = this.#pausePacketByTid.get(paused[0]) ?? ({} as PauseEvent);
    await this.#allStop(paused[0], packet);
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
    const consoleActor =
      consoleActorOverride ?? [...this.#threads.values()].find((t) => t.consoleActor)?.consoleActor;
    if (!consoleActor) throw new Error("no console actor");
    // Firefox may send evaluationResult immediately after the acknowledgement,
    // in the same TCP chunk. Install the listener before sending the request so
    // the promise continuation after `await request()` cannot miss that result.
    let resultID: string | undefined;
    const earlyResults = new Map<string, RdpPacket>();
    let cleanup!: () => void;
    const result = new Promise<RdpPacket>((resolve, reject) => {
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#client.off("event", onEvent);
        this.off("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("JavaScript evaluation timed out after 5000 ms"));
      }, 5000);
      const onEvent = (p: RdpPacket) => {
        if (p.type !== EVENTS.evaluationResult) return;
        const id = (p as { resultID?: string }).resultID;
        if (!id) return;
        if (resultID === undefined) {
          earlyResults.set(id, p);
        } else if (id === resultID) {
          cleanup();
          resolve(p);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("session closed"));
      };
      this.#client.on("event", onEvent);
      this.once("close", onClose);
    });
    try {
      const ack = (await this.#client.request(consoleActor, {
        type: REQUESTS.evaluateJSAsync,
        text,
        ...(frameActor ? { frameActor } : {}),
      })) as EvaluateJSAsyncAck;
      resultID = ack.resultID;
      if (!resultID) throw new Error("Firefox did not return an evaluation result ID");
      const early = earlyResults.get(resultID);
      if (early) {
        cleanup();
        return early;
      }
      return await result;
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearPendingDetachChecks();
    this.#client.close();
  }
}
