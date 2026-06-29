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

// Thread configuration applied before navigation. observeWasm/observeAsmJS so the
// page's wasm compiles with debug support; pauseOnExceptions with
// ignoreCaughtExceptions so we break on uncaught wasm traps (surfacing as a
// stop) without pausing on routine caught JS exceptions.
const THREAD_CONFIG = {
  observeWasm: true,
  observeAsmJS: true,
  pauseOnExceptions: true,
  ignoreCaughtExceptions: true,
};

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
    return (tabs ?? []).map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" }));
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
  client.on("error", () => {}); // prevent unhandled-error crashes on malformed data
  client.registerEventType("tabListChanged");

  const query = async () => {
    const { tabs } = (await client.request("root", { type: "listTabs" })) as {
      tabs?: { actor: string; url?: string; title?: string }[];
    };
    onTabs((tabs ?? []).map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" })));
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
  client.on("error", () => {}); // prevent unhandled-error crashes on malformed data
  client.registerEventType("tabListChanged");

  const primedActors = new Set<string>();

  const primeTab = async (tabActor: string) => {
    if (primedActors.has(tabActor)) return;
    primedActors.add(tabActor);
    try {
      const watcherR = await client.request(tabActor, {
        type: "getWatcher",
        isServerTargetSwitchingEnabled: true,
      });
      const watcher = watcherR.actor as string | undefined;
      if (!watcher) throw new Error("no watcher actor");
      const cfg = await client.request(watcher, { type: "getThreadConfigurationActor" });
      const configActor = ((cfg.configuration as { actor?: string })?.actor ??
        cfg.configuration) as string | undefined;
      if (!configActor) throw new Error("no thread config actor");
      await client.request(configActor, {
        type: "updateConfiguration",
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
    const { tabs } = (await client.request("root", { type: "listTabs" })) as {
      tabs?: { actor: string; url?: string; title?: string }[];
    };
    const tabList = tabs ?? [];
    onTabs(tabList.map((t) => ({ actor: t.actor, url: t.url ?? "", title: t.title ?? "" })));
    for (const t of tabList) void primeTab(t.actor);
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
  callee?: { name?: string; displayName?: string };
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
    if (!tab) throw new Error("no Firefox tab found (Firefox may still be starting)");
    this.#tabActor = tab.actor;

    const watcherResp = await this.#client.request(this.#tabActor, {
      type: "getWatcher",
      isServerTargetSwitchingEnabled: true,
    });
    const watcher = watcherResp.actor as string | undefined;
    if (!watcher) throw new Error("Firefox did not return a watcher actor");
    this.#watcher = watcher;

    const cfg = await this.#client.request(this.#watcher, {
      type: "getThreadConfigurationActor",
    });
    const configActor = ((cfg.configuration as { actor?: string })?.actor ?? cfg.configuration) as
      | string
      | undefined;
    if (!configActor) throw new Error("Firefox did not return a thread config actor");
    await this.#client.request(configActor, {
      type: "updateConfiguration",
      configuration: THREAD_CONFIG,
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
    // Remove all top-level targets before navigating. Workers are managed
    // by Firefox's own target-destroyed-form events. We must remove the
    // current top-level target regardless of its URL — if we only remove
    // targets with a different URL, a same-URL reload leaves the old target
    // in #threads, so target-destroyed-form for it would emit "detached" and
    // incorrectly trigger a process-detach in the consumer.
    for (const [tid, t] of this.#threads) {
      if (t.isTopLevel) {
        this.#threads.delete(tid);
        this.#pausedTids.delete(tid);
        this.#interruptedTids.delete(tid);
      }
    }
    // Clear source-actor caches — actors are scoped to an RDP connection and
    // become invalid after navigation. Stale actors cause breakpoint-position
    // queries (#snapJsLocation, wasmBreakpointOffsets) to fail silently and
    // fall back to un-snapped positions, which Firefox may ignore.
    this.#jsActorByUrl.clear();
    this.#wasmActorByUrl.clear();

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
      const onTarget = (t: ThreadInfo) => {
        if (t.isTopLevel && t.url === url) {
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
      await this.#client.request(this.#tabActor, { type: "navigateTo", url, waitForLoad: true });
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
      type: "sources",
    })) as { sources?: unknown[] };
    const wasm = ((sources ?? []) as SourceForm[]).filter((s) => s.introductionType === "wasm");
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

  /** Expose the wasm actor map so rdp-debuggee can fall back to it. */
  wasmActorForUrl(url: string): string | undefined {
    return this.#wasmActorByUrl.get(url);
  }

  /** Expose the wasm actor map so rdp-debuggee can fall back to it. */
  wasmActorForUrl(url: string): string | undefined {
    return this.#wasmActorByUrl.get(url);
  }

  async fetchModuleBytes(url: string): Promise<Uint8Array> {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return new Uint8Array(await (await fetch(url)).arrayBuffer());
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
    return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  }

  /** Try to fetch raw wasm bytes from a source actor via RDP. */
  async #fetchWasmBytesFromActor(sourceActor: string): Promise<Uint8Array | null> {
    try {
      const resp = (await this.#client.request(sourceActor, { type: "source" })) as {
        source?: unknown;
      };
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
    // cols[0] is undefined if positions returns a line with an empty column list.
    return cols.length > 0 ? { line: snLine, column: cols[0] } : { line: snLine };
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
        type: "frames",
        start,
        count,
      });
      const { frames } = (await Promise.race([req, timeout, closeP])) as {
        frames?: unknown;
      };
      return (frames ?? []) as FrameForm[];
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
    // Snap to the same offset that setWasmBreakpoint used; removing the
    // original offset would be a no-op if it was adjusted on set.
    const snappedOffset = await this.#snapOffset(sourceUrl, offset);
    await Promise.all(
      [...this.#threads.values()].map((t) =>
        this.#client
          .request(t.threadActor, {
            type: "removeBreakpoint",
            location: { sourceUrl, line: snappedOffset, column: 1 },
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
      .filter((n) => !Number.isNaN(n))
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
    await this.#allStop(paused[0], {} as PauseEvent);
    return true;
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
        if (p.type === "evaluationResult" && (p as { resultID?: string }).resultID === resultID) {
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
    this.#client.close();
  }
}
