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
  type ThreadConfig,
  type TabInfo,
  type RdpTabForm,
  type ListTabsResponse,
  type GetRootResponse,
  type GetCharPrefResponse,
  type GetWatcherResponse,
  type GetThreadConfigurationActorResponse,
  type SourceForm,
  type SourcesResponse,
  type SourceResponse,
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
import { LAUNCH_TOKEN_PREF } from "./firefox.js";
import { EMPTY_WASM_MODULE, DETACH_GRACE_MS } from "./constants.js";
import { noopLogger, type RspLogger } from "../protocol/rsp-server.js";

export { grip, type TabInfo, type SourceForm, type FrameForm, type PauseEvent, type StoppedEvent };

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
): Promise<void> {
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
      return;
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

/** Watch tab list changes, calling onTabs on every change. Resolves when the connection closes. */
export async function watchFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void
): Promise<void> {
  const client = await RdpClient.connect(port, host);
  client.on("error", () => {}); // prevent unhandled-error crashes on malformed data

  const query = async () => {
    const { tabs } = (await client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse;
    onTabs(toTabInfos(tabs));
  };

  client.on("event", (p) => {
    if (p.type === EVENTS.tabListChanged || p.type === EVENTS.tabNavigated) void query();
  });

  await query();
  // One delayed re-query to handle the startup race where Firefox hadn't
  // created any tabs yet when we first connected (listTabs returned []).
  const startupRetry = setTimeout(() => void query().catch(() => {}), 2000);

  await new Promise<void>((resolve) =>
    client.on("close", () => {
      clearTimeout(startupRetry);
      resolve();
    })
  );
}

/**
 * Like watchFirefoxTabs, but also enables observeWasm:true on each tab via a
 * persistent watcher. The thread config survives page navigation: any page
 * loaded in a primed tab after this call compiles wasm in debug mode, making
 * breakpoints available without a reload. Resolves when the connection closes.
 */
export async function watchAndPrimeFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void
): Promise<void> {
  const client = await RdpClient.connect(port, host);
  client.on("error", () => {}); // prevent unhandled-error crashes on malformed data

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
    } catch {
      // Tab may have disappeared; ignore and let the next query re-prime it.
      primedActors.delete(tabActor);
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
      void query().catch(() => {});
  });

  await query();
  const startupRetry = setTimeout(() => void query().catch(() => {}), 2000);

  await new Promise<void>((resolve) =>
    client.on("close", () => {
      clearTimeout(startupRetry);
      resolve();
    })
  );
}

export interface ThreadInfo {
  tid: number;
  targetActor: string;
  threadActor: string;
  consoleActor: string;
  url: string;
  isTopLevel: boolean;
}

export class RdpWasmSession extends EventEmitter {
  #client: RdpClient;
  #logger: RspLogger;
  #tabActor!: string;
  #watcher!: string;

  // tid -> ThreadInfo (including the top-level frame target)
  #threads = new Map<number, ThreadInfo>();
  #nextTid = 1;

  // tid of the thread that triggered the most recent all-stop pause
  #stoppedTid = 1;

  // tids that we interrupted during all-stop (to be resumed on next continue)
  #interruptedTids = new Set<number>();
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

  // breakpoints buffered so new workers inherit them
  #breakpoints = new Map<string, Set<number>>(); // sourceUrl -> set of offsets

  #wasmActorByUrl = new Map<string, string>(); // url -> source actor (any thread)
  #breakpointPositionCache = new Map<string, Promise<number[]>>(); // actor -> positions
  #jsActorByUrl = new Map<string, string>(); // url -> JS source actor (any thread)
  // Reverse of the two maps above (wasm + JS actors share one namespace).
  // The single owner of actor->url lookups — RdpDebuggee reads it via
  // urlForSourceActor() instead of keeping its own copy.
  #sourceUrlByActor = new Map<string, string>();

  // Pending "is this top-level destroy a real close?" checks (see DETACH_GRACE_MS).
  #pendingDetachChecks = new Set<ReturnType<typeof setTimeout>>();

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

  private constructor(client: RdpClient, logger: RspLogger) {
    super();
    this.#client = client;
    this.#logger = logger;
    // Forward transport close so consumers can unblock pending promises.
    client.on("close", () => this.emit("close"));
    // Absorb transport errors (malformed data, JSON parse failures) so an
    // unhandled 'error' event doesn't crash the process. The socket will also
    // emit 'close' immediately after, which triggers proper cleanup.
    client.on("error", () => {});
  }

  // --- public accessors ---

  get stoppedTid(): number {
    return this.#stoppedTid;
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

  /** Connect, enable wasm observation, and start watching targets. */
  static async start(
    port = 6080,
    host = "127.0.0.1",
    tabActor?: string,
    logger: RspLogger = noopLogger
  ): Promise<RdpWasmSession> {
    const client = await RdpClient.connect(port, host);
    const session = new RdpWasmSession(client, logger);
    await session.#init(tabActor);
    return session;
  }

  async #init(tabActor?: string): Promise<void> {
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
        if (isTopLevel && this.#pendingTopLevelTid !== undefined) {
          tid = this.#pendingTopLevelTid;
          this.#pendingTopLevelTid = undefined;
        } else {
          tid = this.#nextTid++;
        }
        const info: ThreadInfo = {
          tid,
          targetActor,
          threadActor,
          consoleActor: target.consoleActor ?? "",
          url: target.url ?? "",
          isTopLevel,
        };
        this.#threads.set(tid, info);

        // Apply any buffered breakpoints to the new worker.
        void this.#applyBreakpoints(info);

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
          const [tid, info] = entry;
          this.#threads.delete(tid);
          this.#pausedTids.delete(tid);
          this.#pausePacketByTid.delete(tid);
          this.#interruptedTids.delete(tid);
          // The page's tab was closed or navigated away; let consumers react
          // (e.g. firefox-lldb detaches the lldb process). Give a Fission
          // process-swap replacement (see DETACH_GRACE_MS) a chance to arrive
          // first, so a swap isn't mistaken for a real close.
          if (info.isTopLevel) {
            // Whether this was a navigate() we drove or the page navigating
            // on its own, every source actor scoped to the old top-level
            // target is now dead.
            this.#onTopLevelGone(info);
            // Offer this tid to whatever top-level target replaces this one
            // (see #pendingTopLevelTid). If nothing does — a genuine close —
            // the timeout below clears it; nothing will ever ask for it again.
            this.#pendingTopLevelTid = tid;
            const timer = setTimeout(() => {
              this.#pendingDetachChecks.delete(timer);
              const hasTopLevel = [...this.#threads.values()].some((t) => t.isTopLevel);
              if (!hasTopLevel) {
                this.#pendingTopLevelTid = undefined;
                this.emit("detached", info);
              }
            }, DETACH_GRACE_MS);
            this.#pendingDetachChecks.add(timer);
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
        // No one is listening for this specific pause right now (armAllStop
        // isn't currently coordinating it) — e.g. a newly-navigated page's
        // buffered breakpoint fires before the next Debuggee.continue arms
        // the all-stop machinery. Remember it as unwitnessed so the next
        // continue adopts it instead of blindly resuming past it (see
        // hasUnwitnessedPause() and its caller in rdp-debuggee.ts).
        if (this.listenerCount(`paused:${tid}`) === 0) this.#unwitnessedPausedTids.add(tid);
        this.emit(`paused:${tid}`, p as PauseEvent);
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

  /** Navigate the tab; resolves once a top-level target with the given URL arrives. */
  async navigate(url: string): Promise<void> {
    // Remove all top-level targets before navigating. Workers are managed
    // by Firefox's own target-destroyed-form events. We must remove the
    // current top-level target regardless of its URL — if we only remove
    // targets with a different URL, a same-URL reload leaves the old target
    // in #threads, so target-destroyed-form for it would emit "detached" and
    // incorrectly trigger a process-detach in the consumer.
    let removed: ThreadInfo | undefined;
    for (const [tid, t] of this.#threads) {
      if (t.isTopLevel) {
        this.#threads.delete(tid);
        this.#pausedTids.delete(tid);
        this.#pausePacketByTid.delete(tid);
        this.#interruptedTids.delete(tid);
        removed = t;
        // Firefox's own target-destroyed-form for this target won't find it
        // in #threads anymore (we just removed it above) to offer this tid
        // to its replacement itself — do it here instead.
        this.#pendingTopLevelTid = tid;
      }
    }
    // Clear source-actor caches — actors are scoped to an RDP connection and
    // become invalid after navigation. Stale actors cause breakpoint-position
    // queries (#snapJsLocation, wasmBreakpointOffsets) to fail silently and
    // fall back to un-snapped positions, which Firefox may ignore. Also lets
    // a live LLDB attachment know to re-sync.
    this.#onTopLevelGone(removed);

    // Keep a reference to the cleanup function so we can call it if navigateTo
    // throws before we reach `await target` (otherwise the listeners leak).
    const cleanupRef = { fn: null as (() => void) | null };
    const target = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        cleanupRef.fn = null;
        this.off("target", onTarget);
        this.off("close", onClose);
      };
      cleanupRef.fn = cleanup;
      // Any top-level target arriving after the targets above were cleared is
      // the result of this navigation — do not require its URL to match the
      // requested one: a server-side redirect (bare domain -> www, http ->
      // https, trailing slash, etc.) means the resulting page's URL often
      // differs from what was requested, and requiring an exact match here
      // means navigate() never resolves.
      const onTarget = (t: ThreadInfo) => {
        if (t.isTopLevel) {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("session closed during navigate"));
      };
      this.on("target", onTarget);
      this.on("close", onClose);
    });
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
    }
  }

  /** Find the ThreadInfo for a tid; throw if unknown. */
  #info(tid: number): ThreadInfo {
    const info = this.#threads.get(tid);
    if (!info) throw new Error(`no thread for tid ${tid}`);
    return info;
  }

  /** Send a raw request to an actor (escape hatch for actor-specific packets). */
  request(actor: string, packet: Record<string, unknown>): Promise<RdpPacket> {
    return this.#client.request(actor, packet);
  }

  // --- wasm sources ---

  /** Wasm sources from the given thread. */
  async wasmSourcesForTid(tid: number): Promise<SourceForm[]> {
    const { sources } = (await this.#client.request(this.#info(tid).threadActor, {
      type: REQUESTS.sources,
    })) as SourcesResponse;
    const wasm = (sources ?? []).filter((s) => s.introductionType === "wasm");
    for (const s of wasm) {
      this.#wasmActorByUrl.set(s.url, s.actor);
      this.#sourceUrlByActor.set(s.actor, s.url);
    }
    return wasm;
  }

  /** Wasm sources deduped by URL across all known threads. */
  async wasmSources(): Promise<SourceForm[]> {
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

  wasmActorForUrl(url: string): string | undefined {
    return this.#wasmActorByUrl.get(url);
  }

  /** URL for a wasm or JS source actor, if known (populated by wasmSourcesForTid/jsSources). */
  urlForSourceActor(actor: string): string | undefined {
    return this.#sourceUrlByActor.get(actor);
  }

  async fetchModuleBytes(url: string): Promise<Uint8Array> {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        // Marks this as the debugger's own out-of-band fetch (distinct from
        // the browser's page-load request for the same URL) — lets a server
        // log, or a test harness, tell the two apart.
        const resp = await fetch(url, { headers: { "X-Firefox-Lldb": "module-fetch" } });
        return new Uint8Array(await resp.arrayBuffer());
      } catch (e) {
        // A network failure here (e.g. a self-signed dev cert Node's fetch
        // doesn't trust) must not propagate: Module.bytecode's WIT signature
        // has no error case, so an uncaught throw traps the whole gdbstub
        // component instead of just this one module. Degrade the same way
        // the non-HTTP fallback below does.
        this.#logger.error(
          `[rdp] failed to fetch module bytes from ${url}: ${(e as Error).message}`
        );
        return EMPTY_WASM_MODULE;
      }
    }
    // Non-HTTP URL (e.g. "wasm:" for JSPI synthetic wrapper modules): try the
    // RDP source actor. If that also fails, return a minimal valid wasm binary
    // (magic + version only) so the gdbstub doesn't crash — it will find no
    // DWARF and continue without debug info for this synthetic module.
    const actor = this.#wasmActorByUrl.get(url);
    if (actor) {
      const bytes = await this.#fetchWasmBytesFromActor(actor);
      if (bytes) return bytes;
    }
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
      if (ArrayBuffer.isView(src)) return new Uint8Array((src as ArrayBufferView).buffer);
      if (src instanceof ArrayBuffer) return new Uint8Array(src);
      if (typeof src === "string" && src.length > 4 && src.charCodeAt(0) === 0) {
        // Binary string (latin-1 encoded wasm bytes starting with \0asm)
        const out = new Uint8Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
        return out;
      }
    } catch {
      // fall through
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
    const actor = this.#jsActorByUrl.get(sourceUrl);
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

  async jsSources(): Promise<SourceForm[]> {
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    try {
      const info = this.#threads.get(tids[0])!;
      const { sources } = (await this.#client.request(info.threadActor, {
        type: REQUESTS.sources,
      })) as SourcesResponse;
      const js = (sources ?? []).filter((s) => s.url && s.introductionType !== "wasm");
      for (const s of js) {
        this.#jsActorByUrl.set(s.url, s.actor);
        this.#sourceUrlByActor.set(s.actor, s.url);
      }
      return js;
    } catch {
      return [];
    }
  }

  // --- frames ---

  async frames(tid: number, start = 0, count = 1000): Promise<FrameForm[]> {
    // Cap at 5 s for threads in mid-resume transition (they never respond).
    // Clear the timer and close listener whether req, timeout, or close wins,
    // so neither lingers in the event loop after the call returns.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("frames timeout")), 5000);
    });
    const closeP = new Promise<never>((_, reject) => {
      onClose = () => reject(new Error("session closed"));
      this.once("close", onClose);
    });
    try {
      const req = this.#client.request(this.#info(tid).threadActor, {
        type: REQUESTS.frames,
        start,
        count,
      });
      const { frames } = (await Promise.race([req, timeout, closeP])) as FramesResponse;
      return frames ?? [];
    } finally {
      clearTimeout(timer);
      if (onClose) this.off("close", onClose);
    }
  }

  // --- breakpoints ---

  async setWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    // Buffer so new workers inherit it.
    if (!this.#breakpoints.has(sourceUrl)) this.#breakpoints.set(sourceUrl, new Set());
    this.#breakpoints.get(sourceUrl)!.add(offset);

    const snappedOffset = await this.#snapOffset(sourceUrl, offset);
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
  }

  async removeWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    this.#breakpoints.get(sourceUrl)?.delete(offset);
    // Snap to the same offset that setWasmBreakpoint used; removing the
    // original offset would be a no-op if it was adjusted on set.
    const snappedOffset = await this.#snapOffset(sourceUrl, offset);
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
    // can be expensive. Subsequent Z0 packets reuse the same list.
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

  async #snapOffset(sourceUrl: string, offset: number): Promise<number> {
    const actor = this.#wasmActorByUrl.get(sourceUrl);
    if (!actor) return offset;
    const positions = await this.wasmBreakpointOffsets(actor).catch((): number[] => []);
    if (!positions.length || positions.includes(offset)) return offset;
    return positions.reduce(
      (best, p) => (Math.abs(p - offset) < Math.abs(best - offset) ? p : best),
      positions[0]
    );
  }

  /** Apply all buffered breakpoints to a newly-arrived thread. */
  async #applyBreakpoints(info: ThreadInfo): Promise<void> {
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
        // Cap each attempt: if the actor never replies (a stale/dead thread,
        // or simply no wasm on this target), this poll must still progress
        // and eventually give up rather than hang on the very first await.
        const sources = await Promise.race([
          this.wasmSourcesForTid(info.tid).catch((): SourceForm[] => []),
          new Promise<SourceForm[]>((resolve) => setTimeout(() => resolve([]), 200)),
        ]);
        if (sources.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    for (const [sourceUrl, offsets] of this.#breakpoints) {
      for (const offset of offsets) {
        const snapped = await this.#snapOffset(sourceUrl, offset);
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
    const toResume = [...this.#pausedTids];
    this.#interruptedTids.clear();
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
      for (const [tid, h] of perTidHandlers) this.off(`paused:${tid}`, h);
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
      void this.#allStop(tid, packet);
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
      const h = (p: PauseEvent) => onPaused(tid, p);
      perTidHandlers.set(tid, h);
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
            this.off("close", onClose);
            resolve();
          };
          const timer = setTimeout(done, 3000);
          const onPaused = done;
          const onClose = done;
          this.once(`paused:${tid}`, onPaused);
          this.once("close", onClose);
        });
        this.#client.send(info.threadActor, { type: REQUESTS.interrupt, when: {} });
        await paused;
        if (this.#pausedTids.has(tid)) this.#interruptedTids.add(tid);
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
        .catch(() => {});
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
    const ack = (await this.#client.request(consoleActor, {
      type: REQUESTS.evaluateJSAsync,
      text,
      ...(frameActor ? { frameActor } : {}),
    })) as EvaluateJSAsyncAck;
    const resultID = ack.resultID;
    return new Promise<RdpPacket>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#client.off("event", onEvent);
        this.off("close", onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("evaluateInFrame timeout"));
      }, 500);
      const onEvent = (p: RdpPacket) => {
        if (
          p.type === EVENTS.evaluationResult &&
          (p as { resultID?: string }).resultID === resultID
        ) {
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
  }

  close(): void {
    for (const timer of this.#pendingDetachChecks) clearTimeout(timer);
    this.#pendingDetachChecks.clear();
    this.#client.close();
  }
}
