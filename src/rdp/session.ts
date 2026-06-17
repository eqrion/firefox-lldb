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
//   - watchTargets("frame") + watchResources("source") to track the current
//     top-level target and its sources across navigation;
//   - thread.setBreakpoint / frames / resume / interrupt, and paused/resumed
//     events scoped to the current thread.
//
// Wasm specifics: a wasm breakpoint location is {sourceUrl, line:<byteOffset>,
// column:1}; a paused wasm frame reports where.line as the byte offset.

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

/**
 * Keep a persistent RDP connection and call onTabs with the current tab list
 * immediately and again whenever the tab list changes. Resolves when the
 * connection closes (e.g. Firefox exits).
 */
export async function watchFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void,
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
    }),
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
  displayName?: string;
  arguments?: unknown[];
}

export interface PauseEvent {
  why?: { type?: string };
  frame?: FrameForm;
}

export class RdpWasmSession extends EventEmitter {
  #client: RdpClient;
  #tabActor!: string;
  #watcher!: string;
  #threadActor: string | null = null;
  #consoleActor: string | null = null;
  #targetUrl = "";
  #wasmActorByUrl = new Map<string, string>();
  #jsActorByUrl = new Map<string, string>();

  private constructor(client: RdpClient) {
    super();
    this.#client = client;
  }

  get threadActor(): string | null {
    return this.#threadActor;
  }
  get targetUrl(): string {
    return this.#targetUrl;
  }

  /** Connect, enable wasm observation, and start watching a tab.
   *  Pass tabActor to target a specific tab; omit to use the selected tab. */
  static async start(port = 6080, host = "127.0.0.1", tabActor?: string): Promise<RdpWasmSession> {
    const client = await RdpClient.connect(port, host);
    const session = new RdpWasmSession(client);
    await session.#init(tabActor);
    return session;
  }

  async #init(tabActor?: string): Promise<void> {
    if (tabActor) {
      this.#tabActor = tabActor;
    } else {
      const { tabs } = (await this.#client.request("root", { type: "listTabs" })) as {
        tabs: { actor: string; selected: boolean }[];
      };
      this.#tabActor = (tabs.find((t) => t.selected) ?? tabs[0]).actor;
    }

    // Server target switching is what makes the watcher instantiate targets and
    // apply thread-config (observeWasm) before page scripts run.
    const { actor: watcher } = await this.#client.request(this.#tabActor, {
      type: "getWatcher",
      isServerTargetSwitchingEnabled: true,
    });
    this.#watcher = watcher as string;

    const cfg = await this.#client.request(this.#watcher, { type: "getThreadConfigurationActor" });
    const configActor = ((cfg.configuration as { actor?: string })?.actor ??
      cfg.configuration) as string;
    await this.#client.request(configActor, {
      type: "updateConfiguration",
      configuration: { observeWasm: true, observeAsmJS: true, pauseOnExceptions: false },
    });

    this.#client.on("event", (p) => this.#onEvent(p));
    await this.#client.request(this.#watcher, { type: "watchTargets", targetType: "frame" });
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
        if (target?.isTopLevelTarget) {
          this.#threadActor = target.threadActor ?? null;
          this.#consoleActor = target.consoleActor ?? null;
          this.#targetUrl = target.url ?? "";
          this.emit("target", target);
        }
        break;
      }
      case "paused":
        if (p.from === this.#threadActor) this.emit("paused", p as PauseEvent);
        break;
      case "resumed":
        if (p.from === this.#threadActor) this.emit("resumed");
        break;
    }
  }

  /** Navigate the tab; resolves once the new top-level target is available. */
  async navigate(url: string): Promise<void> {
    const target = new Promise<void>((resolve) => {
      const onTarget = (t: { url?: string }) => {
        if (t.url === url) {
          this.off("target", onTarget);
          resolve();
        }
      };
      this.on("target", onTarget);
    });
    await this.#client.request(this.#tabActor, { type: "navigateTo", url, waitForLoad: true });
    await target;
  }

  #thread(): string {
    if (!this.#threadActor) throw new Error("no active thread (no target yet)");
    return this.#threadActor;
  }

  /** Send a raw request to an actor (escape hatch for actor-specific packets). */
  request(actor: string, packet: Record<string, unknown>): Promise<RdpPacket> {
    return this.#client.request(actor, packet);
  }

  async sources(): Promise<SourceForm[]> {
    const { sources } = await this.#client.request(this.#thread(), { type: "sources" });
    return sources as SourceForm[];
  }

  async wasmSources(): Promise<SourceForm[]> {
    const wasm = (await this.sources()).filter((s) => s.introductionType === "wasm");
    for (const s of wasm) this.#wasmActorByUrl.set(s.url, s.actor);
    return wasm;
  }

  cacheWasmActor(actor: string, url: string): void {
    this.#wasmActorByUrl.set(url, actor);
  }

  async jsSources(): Promise<SourceForm[]> {
    const js = (await this.sources()).filter((s) => s.url && s.introductionType !== "wasm");
    for (const s of js) this.#jsActorByUrl.set(s.url, s.actor);
    return js;
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
        if (grip.initial !== undefined && grip.initial.length === grip.length) {
          return grip.initial;
        }
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

  /** Fetch a module's bytes by URL (the source actor cannot serve wasm binary). */
  async fetchModuleBytes(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }

  async frames(start = 0, count = 1000): Promise<FrameForm[]> {
    const { frames } = await this.#client.request(this.#thread(), { type: "frames", start, count });
    return (frames ?? []) as FrameForm[];
  }

  /**
   * Set a wasm breakpoint at a byte offset (column is always 1 for wasm).
   *
   * LLDB resolves a breakpoint to a DWARF prologue-end offset, which is not
   * necessarily one of the engine's valid breakpoint positions; setting at an
   * invalid offset is a silent no-op in Firefox. Snap to the nearest valid
   * position so the breakpoint actually arms.
   */
  async setWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    const actor = this.#wasmActorByUrl.get(sourceUrl);
    let line = offset;
    if (actor) {
      const positions = await this.wasmBreakpointOffsets(actor);
      if (positions.length && !positions.includes(offset)) {
        line = positions.reduce(
          (best, p) => (Math.abs(p - offset) < Math.abs(best - offset) ? p : best),
          positions[0]
        );
      }
    }
    await this.#client.request(this.#thread(), {
      type: "setBreakpoint",
      location: { sourceUrl, line, column: 1 },
      options: {},
    });
  }

  async removeWasmBreakpoint(sourceUrl: string, offset: number): Promise<void> {
    await this.#client.request(this.#thread(), {
      type: "removeBreakpoint",
      location: { sourceUrl, line: offset, column: 1 },
    });
  }

  async setJsBreakpoint(sourceUrl: string, line: number): Promise<void> {
    await this.#client.request(this.#thread(), {
      type: "setBreakpoint",
      location: { sourceUrl, line, column: 1 },
      options: {},
    });
  }

  async removeJsBreakpoint(sourceUrl: string, line: number): Promise<void> {
    await this.#client.request(this.#thread(), {
      type: "removeBreakpoint",
      location: { sourceUrl, line, column: 1 },
    });
  }

  /** Valid breakpoint byte offsets for a wasm source (the line numbers). */
  async wasmBreakpointOffsets(sourceActor: string): Promise<number[]> {
    const { positions } = await this.#client.request(sourceActor, {
      type: "getBreakpointPositionsCompressed",
      query: { start: { line: 0 }, end: { line: 1e7 } },
    });
    return Object.keys((positions ?? {}) as Record<string, number[]>)
      .map(Number)
      .sort((a, b) => a - b);
  }

  resume(): Promise<RdpPacket> {
    return this.#client.request(this.#thread(), { type: "resume" });
  }
  step(): Promise<RdpPacket> {
    return this.#client.request(this.#thread(), { type: "resume", resumeLimit: { type: "step" } });
  }
  interrupt(): Promise<RdpPacket> {
    return this.#client.request(this.#thread(), { type: "interrupt", when: {} });
  }

  /** Evaluate JS in the page (used to drive wasm calls during bring-up/tests). */
  async evaluate(text: string): Promise<void> {
    if (!this.#consoleActor) throw new Error("no console actor");
    await this.#client.request(this.#consoleActor, { type: "evaluateJSAsync", text });
  }

  /** Fetch a frame's environment form (with the parent scope chain). */
  frameEnvironment(frameActor: string): Promise<RdpPacket> {
    return this.#client.request(frameActor, { type: "getEnvironment" });
  }

  /** Evaluate JS in a frame's scope (so wasm-instance bindings like `memory0`
   *  are visible) and resolve with the result packet. */
  async evaluateInFrame(text: string, frameActor: string): Promise<RdpPacket> {
    if (!this.#consoleActor) throw new Error("no console actor");
    this.#client.registerEventType("evaluationResult");
    const ack = await this.#client.request(this.#consoleActor, {
      type: "evaluateJSAsync",
      text,
      frameActor,
    });
    const resultID = (ack as { resultID?: string }).resultID;
    return new Promise<RdpPacket>((resolve) => {
      const onEvent = (p: RdpPacket) => {
        if (p.type === "evaluationResult" && (p as { resultID?: string }).resultID === resultID) {
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
