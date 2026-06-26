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
import { EventEmitter } from "node:events";

export interface TabInfo {
  actor: string;
  url: string;
  title: string;
}

/** One-shot: connect, list tabs, disconnect. */
export async function listFirefoxTabs(port = 6080, host = "127.0.0.1"): Promise<TabInfo[]> {
  const client = await RdpClient.connect(port, host);
  try {
    const { tabs } = (await client.request("root", { type: "listTabs" })) as {
      tabs: { actor: string; url?: string; title?: string }[];
    };
    return tabs.map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" }));
  } finally {
    client.close();
  }
}

/** Watch tab list changes, calling onTabs on every change. Resolves when the connection closes. */
export async function watchFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void
): Promise<void> {
  const client = await RdpClient.connect(port, host);
  client.registerEventType("tabListChanged");

  const query = async () => {
    const { tabs } = (await client.request("root", { type: "listTabs" })) as {
      tabs: { actor: string; url?: string; title?: string }[];
    };
    onTabs(tabs.map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" })));
  };

  client.on("event", (p) => {
    if (p.type === "tabListChanged" || p.type === "tabNavigated") void query();
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
  client.registerEventType("tabListChanged");

  const primedActors = new Set<string>();

  const primeTab = async (tabActor: string) => {
    if (primedActors.has(tabActor)) return;
    primedActors.add(tabActor);
    try {
      const { actor: watcher } = (await client.request(tabActor, {
        type: "getWatcher",
        isServerTargetSwitchingEnabled: true,
      })) as { actor: string };
      const cfg = await client.request(watcher, { type: "getThreadConfigurationActor" });
      const configActor = ((cfg.configuration as { actor?: string })?.actor ??
        cfg.configuration) as string;
      await client.request(configActor, {
        type: "updateConfiguration",
        configuration: { observeWasm: true, observeAsmJS: true, pauseOnExceptions: false },
      });
      await client.request(watcher, { type: "watchTargets", targetType: "frame" });
      await client.request(watcher, { type: "watchTargets", targetType: "worker" });
    } catch {
      // Tab may have disappeared; ignore and let the next query re-prime it.
      primedActors.delete(tabActor);
    }
  };

  const query = async () => {
    const { tabs } = (await client.request("root", { type: "listTabs" })) as {
      tabs: { actor: string; url?: string; title?: string }[];
    };
    onTabs(tabs.map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" })));
    for (const t of tabs) void primeTab(t.actor);
  };

  client.on("event", (p) => {
    if (p.type === "tabListChanged" || p.type === "tabNavigated") void query().catch(() => {});
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

export interface SourceForm {
  actor: string;
  url: string;
  introductionType?: string;
}

export interface FrameForm {
  actor: string;
  type: string; // "wasmcall" | "call" | "global" | ...
  where?: { actor: string; line: number; column: number };
  arguments?: unknown[];
}

export interface PauseEvent {
  why?: { type?: string };
  frame?: FrameForm;
}

interface ThreadInfo {
  tid: number;
  threadActor: string;
  consoleActor: string;
  url: string;
  isTopLevel: boolean;
}

// All-stop event: one thread paused and all others have been interrupted.
export interface StoppedEvent {
  tid: number;
  pausePacket: PauseEvent;
}

/** Render an RDP grip (console argument or binding value) as a display string. */
export function grip(a: unknown): string {
  if (a === null) return "null";
  if (typeof a !== "object") return String(a);
  const g = a as { type?: string; class?: string; initial?: string };
  switch (g.type) {
    case "undefined":
    case "null":
    case "Infinity":
    case "-Infinity":
    case "NaN":
      return g.type;
    case "longString":
      return g.initial ?? "[longString]";
    default:
      return g.class ?? g.type ?? "[object]";
  }
}

export class RdpWasmSession extends EventEmitter {
  #client: RdpClient;
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

  // breakpoints buffered so new workers inherit them
  #breakpoints = new Map<string, Set<number>>(); // sourceUrl -> set of offsets

  #wasmActorByUrl = new Map<string, string>(); // url -> source actor (any thread)
  #jsActorByUrl = new Map<string, string>(); // url -> JS source actor (any thread)

  private constructor(client: RdpClient) {
    super();
    this.#client = client;
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

  listTids(): number[] {
    return [...this.#threads.keys()];
  }

  /** URL of the top-level (page) target, if one is connected. */
  topLevelUrl(): string | undefined {
    return [...this.#threads.values()].find((t) => t.isTopLevel)?.url;
  }

  /** Connect, enable wasm observation, and start watching targets. */
  static async start(port = 6080, host = "127.0.0.1", tabActor?: string): Promise<RdpWasmSession> {
    const client = await RdpClient.connect(port, host);
    const session = new RdpWasmSession(client);
    await session.#init(tabActor);
    return session;
  }

  async #init(tabActor?: string): Promise<void> {
    const { tabs } = (await this.#client.request("root", { type: "listTabs" })) as {
      tabs: { actor: string; selected: boolean }[];
    };
    const tab =
      (tabActor ? tabs.find((t) => t.actor === tabActor) : undefined) ??
      tabs.find((t) => t.selected) ??
      tabs[0];
    this.#tabActor = tab.actor;

    const { actor: watcher } = await this.#client.request(this.#tabActor, {
      type: "getWatcher",
      isServerTargetSwitchingEnabled: true,
    });
    this.#watcher = watcher as string;

    const cfg = await this.#client.request(this.#watcher, {
      type: "getThreadConfigurationActor",
    });
    const configActor = ((cfg.configuration as { actor?: string })?.actor ??
      cfg.configuration) as string;
    await this.#client.request(configActor, {
      type: "updateConfiguration",
      configuration: { observeWasm: true, observeAsmJS: true, pauseOnExceptions: false },
    });

    this.#client.on("event", (p) => this.#onEvent(p));
    await this.#client.request(this.#watcher, { type: "watchTargets", targetType: "frame" });
    await this.#client.request(this.#watcher, { type: "watchTargets", targetType: "worker" });
    await this.#client.request(this.#watcher, {
      type: "watchResources",
      resourceTypes: ["source"],
    });
  }

  #onEvent(p: RdpPacket): void {
    switch (p.type) {
      case "target-available-form": {
        const target = p.target as {
          url?: string;
          threadActor?: string;
          consoleActor?: string;
          isTopLevelTarget?: boolean;
        };
        const threadActor = target?.threadActor;
        if (!threadActor) break;

        // Check if this actor is already known (re-announce after navigation).
        const existing = [...this.#threads.values()].find((t) => t.threadActor === threadActor);
        if (existing) break;

        const tid = this.#nextTid++;
        const info: ThreadInfo = {
          tid,
          threadActor,
          consoleActor: target.consoleActor ?? "",
          url: target.url ?? "",
          isTopLevel: target.isTopLevelTarget ?? false,
        };
        this.#threads.set(tid, info);

        // Apply any buffered breakpoints to the new worker.
        void this.#applyBreakpoints(info);

        this.emit("target", info);
        break;
      }
      case "target-destroyed-form": {
        const target = p.target as { threadActor?: string };
        const threadActor = target?.threadActor;
        if (!threadActor) break;
        const entry = [...this.#threads.entries()].find(([, t]) => t.threadActor === threadActor);
        if (entry) {
          const [tid, info] = entry;
          this.#threads.delete(tid);
          this.#pausedTids.delete(tid);
          this.#interruptedTids.delete(tid);
          // The page's tab was closed or navigated away; let consumers react
          // (e.g. firefox-lldb detaches the lldb process).
          if (info.isTopLevel) this.emit("detached", info);
        }
        break;
      }
      case "paused": {
        const fromActor = p.from as string;
        const entry = [...this.#threads.entries()].find(([, t]) => t.threadActor === fromActor);
        if (!entry) break;
        const [tid] = entry;
        this.#pausedTids.add(tid);
        this.emit(`paused:${tid}`, p as PauseEvent);
        break;
      }
      case "resumed": {
        const fromActor = p.from as string;
        const entry = [...this.#threads.entries()].find(([, t]) => t.threadActor === fromActor);
        if (entry) {
          const [tid] = entry;
          this.#pausedTids.delete(tid);
        }
        break;
      }
    }
  }

  /** Navigate the tab; resolves once a top-level target with the given URL arrives. */
  async navigate(url: string): Promise<void> {
    // Remove stale top-level target (pre-navigation). Workers are managed
    // by Firefox's own target-destroyed-form events.
    for (const [tid, t] of this.#threads) {
      if (t.isTopLevel && t.url !== url) {
        this.#threads.delete(tid);
        this.#pausedTids.delete(tid);
        this.#interruptedTids.delete(tid);
      }
    }

    const target = new Promise<void>((resolve) => {
      const onTarget = (t: ThreadInfo) => {
        if (t.isTopLevel && t.url === url) {
          this.off("target", onTarget);
          resolve();
        }
      };
      this.on("target", onTarget);
    });
    await this.#client.request(this.#tabActor, { type: "navigateTo", url, waitForLoad: true });
    await target;
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
    const { sources } = await this.#client.request(this.#info(tid).threadActor, {
      type: "sources",
    });
    const wasm = (sources as SourceForm[]).filter((s) => s.introductionType === "wasm");
    for (const s of wasm) this.#wasmActorByUrl.set(s.url, s.actor);
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

  async fetchModuleBytes(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }

  async fetchSourceText(sourceActor: string): Promise<string> {
    const resp = (await this.#client.request(sourceActor, { type: "source" })) as {
      source?: unknown;
    };
    const src = resp.source;
    if (typeof src === "string") return src;
    if (src && typeof src === "object") {
      const grip = src as { type?: string; actor?: string; length?: number; initial?: string };
      if (grip.type === "longString" && grip.actor && grip.length !== undefined) {
        if (grip.initial !== undefined && grip.initial.length === grip.length) return grip.initial;
        const sub = (await this.#client.request(grip.actor, {
          type: "substring",
          start: 0,
          end: grip.length,
        })) as { substring?: string };
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
            type: "setBreakpoint",
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
            type: "removeBreakpoint",
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
      const resp = await this.#client.request(actor, {
        type: "getBreakpointPositionsCompressed",
        query: { start: { line: 0 }, end: { line: 1e7 } },
      });
      positions = (resp.positions ?? {}) as Record<string, number[]>;
    } catch {
      return { line };
    }
    const lines = Object.keys(positions)
      .map(Number)
      .sort((a, b) => a - b);
    if (!lines.length) return { line };
    const snLine = lines.find((l) => l >= line) ?? lines[lines.length - 1];
    const cols = (positions[String(snLine)] ?? []).slice().sort((a, b) => a - b);
    return { line: snLine, column: cols[0] };
  }

  async jsSources(): Promise<SourceForm[]> {
    const tids = [...this.#threads.keys()].sort((a, b) => a - b);
    if (tids.length === 0) return [];
    try {
      const info = this.#threads.get(tids[0])!;
      const { sources } = (await this.#client.request(info.threadActor, {
        type: "sources",
      })) as { sources?: unknown[] };
      const js = ((sources ?? []) as SourceForm[]).filter(
        (s) => s.url && s.introductionType !== "wasm"
      );
      for (const s of js) this.#jsActorByUrl.set(s.url, s.actor);
      return js;
    } catch {
      return [];
    }
  }

  // --- frames ---

  async frames(tid: number, start = 0, count = 1000): Promise<FrameForm[]> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("frames timeout")), 5000)
    );
    const req = this.#client.request(this.#info(tid).threadActor, {
      type: "frames",
      start,
      count,
    });
    const { frames } = (await Promise.race([req, timeout])) as { frames?: unknown };
    return (frames ?? []) as FrameForm[];
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
              type: "setBreakpoint",
              location: { sourceUrl, line: snappedOffset, column: 1 },
              options: {},
            })
            .catch(() => {}) // ignore stale actors
      )
    );
  }

  async removeWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    this.#breakpoints.get(sourceUrl)?.delete(offset);
    await Promise.all(
      [...this.#threads.values()].map((t) =>
        this.#client
          .request(t.threadActor, {
            type: "removeBreakpoint",
            location: { sourceUrl, line: offset, column: 1 },
          })
          .catch(() => {})
      )
    );
  }

  async wasmBreakpointOffsets(sourceActor: string): Promise<number[]> {
    const { positions } = await this.#client.request(sourceActor, {
      type: "getBreakpointPositionsCompressed",
      query: { start: { line: 0 }, end: { line: 1e7 } },
    });
    return Object.keys((positions ?? {}) as Record<string, number[]>)
      .map(Number)
      .sort((a, b) => a - b);
  }

  async #snapOffset(sourceUrl: string, offset: number): Promise<number> {
    const actor = this.#wasmActorByUrl.get(sourceUrl);
    if (!actor) return offset;
    const positions = await this.wasmBreakpointOffsets(actor);
    if (!positions.length || positions.includes(offset)) return offset;
    return positions.reduce(
      (best, p) => (Math.abs(p - offset) < Math.abs(best - offset) ? p : best),
      positions[0]
    );
  }

  /** Apply all buffered breakpoints to a newly-arrived thread. */
  async #applyBreakpoints(info: ThreadInfo): Promise<void> {
    for (const [sourceUrl, offsets] of this.#breakpoints) {
      for (const offset of offsets) {
        const snapped = await this.#snapOffset(sourceUrl, offset);
        await this.#client
          .request(info.threadActor, {
            type: "setBreakpoint",
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
      this.#client.send(info.threadActor, { type: "resume" });
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
    this.#client.send(info.threadActor, { type: "resume", resumeLimit: { type: limit } });
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
    };

    const onPaused = (tid: number, packet: PauseEvent) => {
      if (fired) return;
      fired = true;
      cleanup();
      void this.#allStop(tid, packet);
    };

    const addTid = (tid: number) => {
      if (fired) return;
      const h = (p: PauseEvent) => onPaused(tid, p);
      perTidHandlers.set(tid, h);
      this.on(`paused:${tid}`, h);
    };

    onNewTarget = (info: ThreadInfo) => addTid(info.tid);
    this.on("target", onNewTarget);

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
        // (e.g. a futex-blocked worker whose JS loop is frozen).
        const paused = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          this.once(`paused:${tid}`, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        this.#client.send(info.threadActor, { type: "interrupt", when: {} });
        await paused;
        if (this.#pausedTids.has(tid)) this.#interruptedTids.add(tid);
      })
    );

    this.emit("stopped", { tid: stoppedTid, pausePacket: packet } as StoppedEvent);
  }

  interrupt(tid: number): void {
    this.#client.send(this.#info(tid).threadActor, { type: "interrupt", when: {} });
  }

  // --- console ---

  /** Evaluate JS in the page (used to drive wasm calls during tests). */
  async evaluate(text: string): Promise<void> {
    // Use the first thread with a console actor.
    const info = [...this.#threads.values()].find((t) => t.consoleActor);
    if (!info) throw new Error("no console actor");
    await this.#client.request(info.consoleActor, { type: "evaluateJSAsync", text });
  }

  get consoleActor(): string | null {
    return [...this.#threads.values()].find((t) => t.consoleActor)?.consoleActor ?? null;
  }

  /** Stream the page's console output (console.* and uncaught errors) to
   * `onMessage`. Listeners are started on every current and future target's
   * console actor, so worker output is included too. */
  async streamConsole(onMessage: (text: string) => void): Promise<void> {
    this.#client.registerEventType("consoleAPICall");
    this.#client.registerEventType("pageError");
    this.#client.on("event", (p) => {
      if (p.type === "consoleAPICall") {
        const m = (p as { message?: { level?: string; arguments?: unknown[] } }).message;
        if (m) onMessage(`console.${m.level ?? "log"}: ${(m.arguments ?? []).map(grip).join(" ")}`);
      } else if (p.type === "pageError") {
        const e = (p as { pageError?: { errorMessage?: string; warning?: boolean } }).pageError;
        if (e && !e.warning) onMessage(`error: ${e.errorMessage ?? ""}`);
      }
    });
    const started = new Set<string>();
    const startFor = (actor: string): void => {
      if (!actor || started.has(actor)) return;
      started.add(actor);
      void this.#client
        .request(actor, { type: "startListeners", listeners: ["ConsoleAPI", "PageError"] })
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
    return this.#client.request(frameActor, { type: "getEnvironment" });
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
    this.#client.registerEventType("evaluationResult");
    const ack = await this.#client.request(consoleActor, {
      type: "evaluateJSAsync",
      text,
      ...(frameActor ? { frameActor } : {}),
    });
    const resultID = (ack as { resultID?: string }).resultID;
    return new Promise<RdpPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#client.off("event", onEvent);
        reject(new Error("evaluateInFrame timeout"));
      }, 500);
      const onEvent = (p: RdpPacket) => {
        if (p.type === "evaluationResult" && (p as { resultID?: string }).resultID === resultID) {
          clearTimeout(timer);
          this.#client.off("event", onEvent);
          resolve(p);
        }
      };
      this.#client.on("event", onEvent);
    });
  }

  close(): void {
    this.#client.close();
  }
}
