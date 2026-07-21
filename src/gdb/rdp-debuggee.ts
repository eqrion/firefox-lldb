/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Implements the gdbstub component's WIT `debuggee` interface (as dispatched
// over the worker SAB-RPC) on top of a live Firefox RDP session.
//
// Thread model: each Firefox thread actor maps to a gdbstub TID. Frames,
// locals, and globals are per-thread. Linear memory is shared — any stopped
// thread's `memory0` scope gives the same buffer.
//
// Both wasm (`wasmcall`) and JS (`call`) RDP frames are surfaced so LLDB sees
// the real interleaved call stack. JS sources are represented as synthetic wasm
// modules built lazily on the first stop that includes a JS frame. Each
// synthetic module carries DWARF that maps address L to source line L. JS
// frames report pc = where.line + codeOffset so LLDB's subtraction of the code
// section offset recovers the DWARF address (= the source line).
//
// The lazy approach avoids slow startup: synthetic modules are built only for
// JS sources that actually appear in the stopped call stack. Because
// #snapshotAll() runs inside EventFuture.finish (before the component's
// update_on_stop -> all_modules call), any synthetic module built here is
// present in addr_space before frame_to_pc runs.
//
// WIT changes vs the single-thread version:
//   - Debuggee.listThreads  -> session.listTids()
//   - Debuggee.stoppedThread -> session.stoppedTid
//   - Debuggee.exitFrames(tid) -> per-tid snapshot
//   - Debuggee.singleStep(tid, resumption) -> session.stepOne(tid)
//   - Debuggee.continue     -> session.resumeAll()
//   - EventFuture.finish    -> awaits all-stop "stopped" event, then snapshots

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import type {
  RdpWasmSession,
  FrameForm,
  StoppedEvent,
  PauseEvent,
  ThreadInfo,
} from "../rdp/session.js";
import { buildSyntheticModule } from "./synthetic-module.js";
import { inspect as inspectWasm, convert as convertSourceMap } from "../sourcemap/converter.js";

// After a navigation swaps in a new top-level target while LLDB is waiting on
// a stop (a Debuggee.continue is armed), give a buffered breakpoint on the
// new page this long to fire naturally through the normal all-stop path
// before forcing a re-sync stop. Same order of magnitude as session.ts's
// DETACH_GRACE_MS, but this is a distinct concern: that one decides whether a
// target swap was a real close, this one decides whether to force a stop so
// the gdbstub component's update_on_stop -> all_modules re-sync ever runs.
const RESYNC_GRACE_MS = 250;

// A minimal valid wasm binary (magic + version only, no sections). Served for
// a Module ref whose #moduleById entry a navigation already cleared — no
// DWARF for it, but a valid module body instead of an uncaught throw across
// a WIT call with no error case (mirrors session.ts's EMPTY_WASM_MODULE).
const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function urlBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return basename(url) || "source.js";
}

export interface RpcRequest {
  type: string;
  id: number;
  method: string;
  args: unknown[];
}

// Upper bound on a single memory read. LLDB chunks reads to its negotiated
// packet size, far below this, so a request above it means the session is being
// driven by the generic gdb-remote plugin (not `--plugin wasm`), which
// misinterprets the wasm address space and asks for absurd lengths. Reject those
// instead of allocating gigabytes and OOM-ing the worker.
const MAX_MEMORY_READ = 16 * 1024 * 1024;

function outOfBounds(): Error {
  return Object.assign(new Error("out-of-bounds"), { payload: "out-of-bounds" });
}

type Ref = { $res: string; id: number };

export class RdpDebuggee {
  #session: RdpWasmSession;
  #nextId = 1;

  // Stable module identity per source URL.
  #moduleByUrl = new Map<string, { id: number; url: string }>();
  #moduleById = new Map<number, { id: number; url: string }>();
  #sourceActorToUrl = new Map<string, string>();

  // Synthetic modules for JS sources: url -> {bytecode, codeOffset}.
  #syntheticByUrl = new Map<string, { bytecode: Uint8Array; codeOffset: number }>();

  // Cache of bytecode served to LLDB per wasm URL. For modules that ship a
  // source map instead of DWARF, this holds the source-map-derived bytecode.
  #bytecodeByUrl = new Map<string, Uint8Array>();

  // Temp dir for materialized JS source text (for LLDB source list).
  #tmpDir: string = mkdtempSync(join(tmpdir(), "firefox-lldb-"));

  // Per-tid frame snapshots (innermost-first wasm+JS frames, set on each stop).
  #framesByTid = new Map<number, FrameForm[]>();

  // Frame ref id -> {tid, index} (reset on each stop).
  #frameInfoById = new Map<number, { tid: number; index: number }>();

  // Instance refs (id -> module URL).
  #instanceUrlById = new Map<number, string>();

  // WasmValue refs (id -> {tag, raw}); raw is the JS value from RDP bindings.
  #valueById = new Map<number, { tag: string; raw: number | bigint }>();

  // Global refs (id -> global index in the instance's global index space).
  #globalIndexById = new Map<number, number>();

  // Per-tid innermost wasm frame actor (for memory/global reads in that thread's scope).
  #topFrameActorByTid = new Map<number, string | null>();

  // Cached frame environment per actor for the current stop cycle. Reset on
  // each stop. Avoids O(locals²) getEnvironment round-trips: without this,
  // each qWasmLocal packet would trigger a separate getEnvironment call.
  #envCacheByActor = new Map<string, Record<string, { value?: unknown }>>();

  // Resolves on the next all-stop "stopped" event (armed before resume/step).
  // Rejects if the session closes before a stop arrives (see constructor).
  #stopped: Promise<StoppedEvent> = Promise.resolve({ tid: 1, pausePacket: {} });
  #resolveStopped: ((e: StoppedEvent) => void) | null = null;
  #rejectStopped: ((e: Error) => void) | null = null;
  #lastPauseReason = "breakpoint";
  // Set when triggerInterrupt() fires before Debuggee.continue has armed #stopped
  // (the SIGINT handler runs synchronously but dispatch runs on the drain timer).
  // #armStopped() checks this and resolves immediately.
  #pendingInterrupt = false;

  // Fired once on LLDB's first continue (drives the page's wasm export
  // after a breakpoint is armed, so the engine pauses inside wasm).
  #onFirstContinue: (() => void) | null = null;

  // Pending "force a re-sync stop if nothing paused naturally" check, armed
  // when a new top-level target arrives while a continue is outstanding (see
  // #scheduleResyncCheck).
  #resyncTimer: ReturnType<typeof setTimeout> | null = null;
  // Set just before #scheduleResyncCheck forces a fresh RDP interrupt to
  // manufacture a stop. Firefox reports that pause's why.type as
  // "interrupted", which the component's Event::Interrupted arm treats as
  // spurious and just resumes from (it's meant for a real client Ctrl-C,
  // which this isn't). Override the tag to "breakpoint" for this one stop so
  // it lands in the arm that actually consults update_on_stop()'s changed
  // modules and reports MultiThreadStopReason::Library.
  #forcingResyncStop = false;

  constructor(session: RdpWasmSession, opts?: { onFirstContinue?: () => void }) {
    this.#session = session;
    this.#onFirstContinue = opts?.onFirstContinue ?? null;

    session.on("stopped", (e: StoppedEvent) => {
      this.#clearResyncTimer();
      if (!this.#resolveStopped) return;
      this.#lastPauseReason = this.#forcingResyncStop
        ? "breakpoint"
        : ((e.pausePacket as { why?: { type?: string } })?.why?.type ?? "breakpoint");
      this.#forcingResyncStop = false;
      this.#resolveStopped(e);
      this.#resolveStopped = null;
      this.#rejectStopped = null;
    });

    session.on("close", () => {
      this.#clearResyncTimer();
      // Unblock any pending EventFuture.finish / primeStop so the gdbstub
      // worker thread doesn't hang when the RDP connection drops mid-session.
      this.#rejectStopped?.(new Error("session closed"));
      this.#resolveStopped = null;
      this.#rejectStopped = null;
    });

    // A navigation (driven or page-triggered) invalidates every per-URL cache
    // below — the actors/bodies they hold belonged to the destroyed target.
    session.on("navigated", () => this.#onNavigated());

    // Give the new page a chance to pause on its own (a buffered breakpoint
    // firing), then force it paused if it doesn't — see #scheduleResyncCheck.
    // This must not happen synchronously/immediately: a driven navigate()
    // is still awaiting Firefox's own navigateTo{waitForLoad:true} reply at
    // this point, which only arrives once the new page's `load` event fires
    // — interrupting the thread right now would freeze it before `load` can
    // ever fire, deadlocking that await forever.
    session.on("target", (info: ThreadInfo) => {
      if (info.isTopLevel) this.#scheduleResyncCheck(info.tid);
    });

    const tmpDir = this.#tmpDir;
    process.on("exit", () => {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        /* best-effort */
      }
    });
  }

  async dispatch(req: RpcRequest): Promise<unknown> {
    const { type, id, method, args } = req;
    const key = `${type}.${method}`;
    switch (key) {
      case "Debuggee.allModules":
        return this.#allModules();
      case "Debuggee.allInstances":
        return this.#allInstances();
      case "Debuggee.listThreads":
        return this.#session.listTids();
      case "Debuggee.stoppedThread":
        return this.#session.stoppedTid;
      case "Debuggee.exitFrames": {
        const tid = args[0] as number;
        return this.#exitFrames(tid);
      }
      case "Debuggee.continue": {
        this.#armStopped();
        // #resolveStopped is null when a pending interrupt was already consumed.
        // In that case the stop is immediate — skip the resume so Firefox stays paused.
        if (this.#resolveStopped !== null) {
          if (this.#session.hasUnwitnessedPause()) {
            // A pause already happened with nothing listening for it — e.g. a
            // buffered breakpoint fired on a newly-navigated page before this
            // continue armed the all-stop machinery (armAllStop's paused:<tid>
            // listeners weren't registered yet). resumeAll() would resume
            // straight past that paused thread and nothing would stop again.
            // Surface the pause we already have instead of losing it. A tid
            // merely left over from an already-reported stop (e.g. primeStop's
            // initial interrupt) isn't one of these and takes the normal path.
            void this.#session.adoptPausedState();
          } else {
            this.#session.armAllStop();
            this.#session.resumeAll().catch(() => {});
            const cb = this.#onFirstContinue;
            this.#onFirstContinue = null;
            cb?.();
          }
        }
        return this.#eventFutureRef();
      }
      case "Debuggee.singleStep": {
        const tid = args[0] as number;
        this.#armStopped();
        // LLDB's own "step off a stale breakpoint before resuming" dance —
        // triggered by its cached, pre-navigation view of where a
        // breakpoint site is — runs as a singleStep BEFORE it ever issues a
        // real continue. If a pause already happened with nothing
        // listening (e.g. a buffered breakpoint refiring on a
        // newly-navigated page, won before this step-off dance even
        // started), stepping now would silently resume straight past it.
        // Surface it instead, same as the Debuggee.continue check.
        if (this.#session.hasUnwitnessedPause()) {
          void this.#session.adoptPausedState();
          return this.#eventFutureRef();
        }
        this.#session.armAllStop();
        // A JS (`call`) innermost frame is JIT-compiled: RDP "step" advances one
        // wasm instruction, which jumps an arbitrary number of JS source lines.
        // Use "next" (RDP step-over by source line) so a step lands on the next
        // JS line. This degrades JS step-in to step-over (single-subprogram
        // synthetic modules can't distinguish JS functions anyway).
        const innermost = this.#framesByTid.get(tid)?.[0];
        const limit = innermost?.type === "call" ? "next" : "step";
        this.#session.stepOne(tid, limit);
        return this.#eventFutureRef();
      }
      case "Debuggee.interrupt": {
        this.#armStopped();
        this.#session.interrupt(this.#session.stoppedTid);
        return null;
      }
      case "EventFuture.finish": {
        await this.#stopped;
        await this.#snapshotAll();
        return { tag: this.#eventTag() };
      }

      case "Module.uniqueId":
        return BigInt(id);
      case "Module.name": {
        // Defensive: a navigation can clear #moduleById out from under a
        // Module ref the component is still holding (its own addr_space
        // hasn't pruned it yet — that only happens on the next stop's
        // update_on_stop). Name is display-only; degrade rather than crash
        // the whole gdbstub worker on a WIT call with no error case.
        const entry = this.#moduleById.get(id);
        if (!entry) return "<stale module>";
        // Suffix with the module id so a same-URL reload or a navigation
        // back to a previously-seen URL gets a name LLDB has never seen
        // before. LLDB's own library-list diff appears to key off this
        // name string, not the reported address: reusing a bare basename
        // ("math.wasm") across two different module incarnations reads to
        // it as "the same library, still loaded, nothing to do", so it
        // never re-resolves breakpoints bound to the one it already knew
        // about — confirmed by tracing real RSP traffic (its own Z0
        // rebind-attempt only ever retried the stale, pre-navigation
        // address once the name repeated, but correctly picked the new
        // one once the name differed).
        return `${urlBasename(entry.url)}#${id}`;
      }
      case "Module.bytecode": {
        const entry = this.#moduleById.get(id);
        if (!entry) return EMPTY_WASM_MODULE;
        const syn = this.#syntheticByUrl.get(entry.url);
        return syn ? syn.bytecode : this.#wasmBytecode(entry.url);
      }
      case "Module.addBreakpoint": {
        const entry = this.#moduleById.get(id);
        if (!entry) return null;
        const syn = this.#syntheticByUrl.get(entry.url);
        const pc = args[0] as number;
        if (syn) {
          await this.#session.setJsBreakpoint(entry.url, pc - syn.codeOffset);
        } else {
          await this.#session.setWasmBreakpoint(entry.url, pc);
        }
        return null;
      }
      case "Module.removeBreakpoint": {
        const entry = this.#moduleById.get(id);
        if (!entry) return null;
        const syn = this.#syntheticByUrl.get(entry.url);
        const pc = args[0] as number;
        if (syn) {
          await this.#session.removeJsBreakpoint(entry.url, pc - syn.codeOffset);
        } else {
          await this.#session.removeWasmBreakpoint(entry.url, pc);
        }
        return null;
      }

      case "Instance.getModule":
        return this.#moduleRef(this.#instanceUrlById.get(id)!);
      case "Instance.uniqueId":
        return BigInt(this.#moduleByUrl.get(this.#instanceUrlById.get(id)!)!.id);
      case "Instance.getMemory": {
        const iUrl = this.#instanceUrlById.get(id)!;
        if (this.#syntheticByUrl.has(iUrl) || (args[0] as number) !== 0) {
          return Promise.reject(outOfBounds());
        }
        return { $res: "Memory", id: this.#nextId++ };
      }
      case "Instance.getGlobal": {
        const gid = this.#nextId++;
        this.#globalIndexById.set(gid, args[0] as number);
        return { $res: "Global", id: gid };
      }

      case "Global.get":
        return this.#readGlobal(this.#globalIndexById.get(id)!);
      case "Global.uniqueId":
        return BigInt(this.#globalIndexById.get(id)!);
      case "Global.clone": {
        const gid = this.#nextId++;
        this.#globalIndexById.set(gid, this.#globalIndexById.get(id)!);
        return { $res: "Global", id: gid };
      }

      case "Memory.uniqueId":
        return 1n;
      case "Memory.sizeBytes":
        return BigInt(await this.#memorySize());
      case "Memory.pageSizeBytes":
        return 65536n;
      case "Memory.getBytes":
        return this.#readMemory(Number(args[0] as bigint), Number(args[1] as bigint));

      case "Frame.getInstance":
        return this.#frameInstance(id);
      case "Frame.getFuncIndex":
        return 0;
      case "Frame.getPc": {
        const fi = this.#frameInfoById.get(id);
        const frame = fi ? this.#framesByTid.get(fi.tid)?.[fi.index] : undefined;
        const line = frame?.where?.line ?? 0;
        if (frame?.type === "call") {
          const url = this.#sourceActorToUrl.get(frame.where!.actor) ?? frame.where!.actor;
          return line + (this.#syntheticByUrl.get(url)?.codeOffset ?? 0);
        }
        return line;
      }
      case "Frame.getLocals":
        return this.#localsForFrame(id);
      case "Frame.getStack":
        return [];
      case "Frame.parentFrame":
        return this.#parentFrame(id);

      case "WasmValue.getType": {
        const entry = this.#valueById.get(id);
        // Defensive: id not found → report funcref so value_to_bytes returns 0u32
        // rather than crashing with a null-deref (TypeScript ! assertion).
        return { tag: entry?.tag ?? "wasm-funcref" };
      }
      case "WasmValue.unwrapI32": {
        const entry = this.#valueById.get(id);
        return entry ? Number(entry.raw) >>> 0 : 0;
      }
      case "WasmValue.unwrapI64": {
        const entry = this.#valueById.get(id);
        return BigInt(entry?.raw ?? 0);
      }
      case "WasmValue.unwrapF32":
      case "WasmValue.unwrapF64": {
        const entry = this.#valueById.get(id);
        return Number(entry?.raw ?? 0);
      }
      case "WasmValue.clone": {
        const v = this.#valueById.get(id);
        const newId = this.#nextId++;
        // Defensive: id not found → clone as zero i32 rather than crashing.
        this.#valueById.set(newId, v ?? { tag: "wasm-i32", raw: 0 });
        return { $res: "WasmValue", id: newId };
      }

      default:
        throw new Error(`RdpDebuggee: unhandled ${key}`);
    }
  }

  // --- modules -------------------------------------------------------------
  async #allModules(): Promise<Ref[]> {
    // Register wasm modules (keeps actor->url mapping current).
    const wasmSources = await this.#session.wasmSources();
    for (const s of wasmSources) {
      this.#sourceActorToUrl.set(s.actor, s.url);
      this.#moduleRef(s.url);
    }
    // Return refs for all registered modules — wasm plus any synthetic JS
    // modules built lazily during the last #snapshotAll. The component calls
    // allModules() after #snapshotAll() returns, so synthetics built during
    // that snapshot are already present here.
    return [...this.#moduleByUrl.values()].map((m) => ({ $res: "Module", id: m.id }));
  }

  #moduleRef(url: string): Ref {
    let m = this.#moduleByUrl.get(url);
    if (!m) {
      m = { id: this.#nextId++, url };
      this.#moduleByUrl.set(url, m);
      this.#moduleById.set(m.id, m);
    }
    return { $res: "Module", id: m.id };
  }

  // Fetch a real wasm module's bytecode, converting source maps to DWARF on the
  // fly so source-map-only modules are debuggable. Cached per URL.
  async #wasmBytecode(url: string): Promise<Uint8Array> {
    const cached = this.#bytecodeByUrl.get(url);
    if (cached) return cached;
    const bytes = await this.#session.fetchModuleBytes(url);
    const out = await this.#maybeConvertSourceMap(url, bytes);
    this.#bytecodeByUrl.set(url, out);
    return out;
  }

  // If `bytes` carries a source map (and no DWARF), synthesize DWARF from it via
  // the source-map component. Falls back to the original bytes on any failure.
  async #maybeConvertSourceMap(url: string, bytes: Uint8Array): Promise<Uint8Array> {
    let info;
    try {
      info = await inspectWasm(bytes);
    } catch {
      return bytes;
    }
    if (info.hasDwarf || !info.sourceMapUrl) return bytes;

    const mapUrl = info.sourceMapUrl;
    let mapBytes: Uint8Array | undefined;
    if (!mapUrl.startsWith("data:")) {
      try {
        const resolved = new URL(mapUrl, url).href;
        mapBytes = new Uint8Array(await (await fetch(resolved)).arrayBuffer());
      } catch {
        return bytes;
      }
    }

    const compDir = join(this.#tmpDir, `${urlBasename(url)}.src`);
    try {
      const res = await convertSourceMap(bytes, mapBytes, compDir);
      for (const sf of res.sources) {
        const dest = join(compDir, sf.path.replace(/^\/+/, ""));
        try {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, sf.content);
        } catch {
          /* best-effort source materialization */
        }
      }
      return res.wasm;
    } catch {
      return bytes;
    }
  }

  // --- instances -----------------------------------------------------------
  async #allInstances(): Promise<Ref[]> {
    const sources = await this.#session.wasmSources();
    return sources.length ? [this.#instanceRef(sources[0].url)] : [];
  }

  // --- frames --------------------------------------------------------------
  async #snapshotAll(): Promise<void> {
    this.#frameInfoById.clear();
    this.#envCacheByActor.clear();
    const stoppedTid = this.#session.stoppedTid;
    for (const tid of this.#session.listTids()) {
      let frames: FrameForm[] = [];
      // Only fetch frames for the stopped thread. Other threads may be running
      // or in mid-resume transition in Firefox, and calling frames() on them
      // causes a "resumed" event response (in EVENT_TYPES) that never resolves
      // the pending request, leading to 5-second timeouts per thread. Workers
      // that were interrupted are typically in Atomics.wait (no wasm frames),
      // so skipping them is equivalent.
      if (tid === stoppedTid) {
        try {
          const rawFrames = (await this.#session.frames(tid)).filter(
            (f) => (f.type === "wasmcall" || f.type === "call") && f.where
          );
          for (const f of rawFrames) {
            if (f.type === "call") {
              const actor = f.where!.actor;
              if (!this.#sourceActorToUrl.has(actor)) {
                await this.#refreshJsSources();
              }
              const url = this.#sourceActorToUrl.get(actor) ?? actor;
              const calleeName = f.callee?.displayName || f.callee?.name;
              await this.#ensureSynthetic(url, actor, calleeName);
            }
          }
          frames = rawFrames;
        } catch {
          frames = [];
        }
      }
      this.#framesByTid.set(tid, frames);
      this.#topFrameActorByTid.set(tid, frames.find((f) => f.type === "wasmcall")?.actor ?? null);
    }
  }

  async #refreshJsSources(): Promise<void> {
    for (const s of await this.#session.jsSources()) {
      this.#sourceActorToUrl.set(s.actor, s.url || s.actor);
    }
  }

  async #ensureSynthetic(url: string, actor: string, calleeName?: string): Promise<void> {
    if (this.#syntheticByUrl.has(url)) return;
    this.#sourceActorToUrl.set(actor, url);
    let text = "";
    try {
      text = await this.#session.fetchSourceText(actor);
    } catch {
      /* skip */
    }
    const lineCount = text ? text.split("\n").length : 1;
    const name = urlBasename(url);
    const filePath = join(this.#tmpDir, name);
    if (text) {
      try {
        writeFileSync(filePath, text, "utf8");
      } catch {
        /* best-effort */
      }
    }
    const syn = buildSyntheticModule({
      name,
      compDir: dirname(filePath),
      lineCount,
      subprogramName: calleeName,
    });
    this.#syntheticByUrl.set(url, syn);
    this.#moduleRef(url);
  }

  async #exitFrames(tid: number): Promise<Ref[]> {
    const frames = this.#framesByTid.get(tid) ?? [];
    return frames.length ? [this.#frameRef(tid, 0)] : [];
  }

  #frameRef(tid: number, index: number): Ref {
    const id = this.#nextId++;
    this.#frameInfoById.set(id, { tid, index });
    return { $res: "Frame", id };
  }

  #parentFrame(id: number): Ref | null {
    const fi = this.#frameInfoById.get(id);
    if (!fi) return null;
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    if (fi.index + 1 >= frames.length) return null;
    return this.#frameRef(fi.tid, fi.index + 1);
  }

  #frameInstance(frameId: number): Ref {
    const fi = this.#frameInfoById.get(frameId);
    const frames = fi ? (this.#framesByTid.get(fi.tid) ?? []) : [];
    const frame = fi ? frames[fi.index] : undefined;
    const url = this.#sourceActorToUrl.get(frame?.where?.actor ?? "") ?? frame?.where?.actor ?? "";
    return this.#instanceRef(url);
  }

  #instanceRef(url: string): Ref {
    this.#moduleRef(url);
    const id = this.#nextId++;
    this.#instanceUrlById.set(id, url);
    return { $res: "Instance", id };
  }

  // --- locals / memory -----------------------------------------------------
  async #localsForFrame(frameId: number): Promise<Ref[]> {
    const fi = this.#frameInfoById.get(frameId);
    if (!fi) return [];
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    const frame = frames[fi.index];
    if (!frame || frame.type === "call") return [];
    type VarBindings = Record<string, { value?: unknown }>;
    if (!this.#envCacheByActor.has(frame.actor)) {
      // Cache the environment per frame actor per stop. Without this, each
      // qWasmLocal packet triggers a separate getEnvironment round-trip,
      // making locals O(N²) in the number of locals.
      const env = (await this.#session.frameEnvironment(frame.actor)) as {
        bindings?: { variables?: VarBindings };
      };
      this.#envCacheByActor.set(frame.actor, env.bindings?.variables ?? {});
    }
    const vars = this.#envCacheByActor.get(frame.actor)!;
    return Object.keys(vars)
      .map((name) => ({ name, idx: /^var(\d+)$/.exec(name)?.[1] }))
      .filter((e): e is { name: string; idx: string } => e.idx !== undefined)
      .sort((a, b) => Number(a.idx) - Number(b.idx))
      .map((e) => this.#valueRef(vars[e.name].value));
  }

  async #readGlobal(index: number): Promise<Ref> {
    const vars = await this.#instanceScopeBindings();
    return this.#valueRef(vars[`global${index}`]?.value);
  }

  async #instanceScopeBindings(): Promise<Record<string, { value?: unknown }>> {
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    if (!topActor) return {};
    let env = (await this.#session.frameEnvironment(topActor)) as
      | {
          scopeKind?: string;
          parent?: unknown;
          bindings?: { variables?: Record<string, { value?: unknown }> };
        }
      | undefined;
    while (env && env.scopeKind !== "wasm instance") {
      env = env.parent as typeof env;
    }
    return env?.bindings?.variables ?? {};
  }

  #valueRef(raw: unknown): Ref {
    let tag = "wasm-i32";
    let value: number | bigint = 0;
    if (typeof raw === "bigint") {
      tag = "wasm-i64";
      value = raw;
    } else if (typeof raw === "number") {
      value = raw;
      tag = Number.isInteger(raw) ? "wasm-i32" : "wasm-f64";
    }
    const id = this.#nextId++;
    this.#valueById.set(id, { tag, raw: value });
    return { $res: "WasmValue", id };
  }

  async #memorySize(): Promise<number> {
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    const consoleActor = this.#session.stoppedConsoleActor;
    if (!topActor || !consoleActor) return 0;
    try {
      const r = (await this.#session.evaluateInFrame(
        "memory0.buffer.byteLength",
        topActor,
        consoleActor
      )) as { result?: unknown };
      return typeof r.result === "number" ? r.result : 0;
    } catch {
      return 0;
    }
  }

  async #readMemory(addr: number, len: number): Promise<Uint8Array> {
    if (len < 0 || len > MAX_MEMORY_READ) throw outOfBounds();
    const out = new Uint8Array(len);
    const topActor = this.#topFrameActorByTid.get(this.#session.stoppedTid);
    const consoleActor = this.#session.stoppedConsoleActor;
    if (!topActor || !consoleActor) return out;
    const expr =
      `(()=>{const b=memory0.buffer,t=b.byteLength,a=${addr},n=${len},o=new Uint8Array(n);` +
      `if(a<t)o.set(new Uint8Array(b,a,Math.min(n,t-a)));` +
      `let s='';for(const x of o)s+=x.toString(16).padStart(2,'0');return s;})()`;
    const evalOnce = () =>
      this.#session.evaluateInFrame(expr, topActor, consoleActor) as Promise<{ result?: unknown }>;
    let hex = "";
    try {
      const r = await evalOnce();
      hex = typeof r.result === "string" ? r.result : "";
      // Retry once if the result is missing or truncated (transient RDP failure).
      if (len > 0 && hex.length !== len * 2) {
        const r2 = await evalOnce().catch(() => ({}) as { result?: unknown });
        hex = typeof r2.result === "string" ? r2.result : hex;
      }
    } catch {
      try {
        const r2 = await evalOnce();
        hex = typeof r2.result === "string" ? r2.result : "";
      } catch {
        // both attempts failed — return zeros
      }
    }
    for (let i = 0; i < len && i * 2 + 1 < hex.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  // --- resumption ----------------------------------------------------------
  /**
   * Force a genuine all-stop and snapshot live thread state. Called on attach so
   * the stop LLDB sees on connect is backed by a real RDP pause with real frames
   * (issue #21), rather than the synthetic empty placeholder. Must run before the
   * gdbstub component starts, since its startup `update_on_stop` reads the frame
   * snapshot once and never re-snapshots on attach.
   */
  async primeStop(): Promise<void> {
    // Interrupt a live thread (lowest tid = top-level), not the default
    // stoppedTid: after a navigate the top-level target re-arrives under a fresh
    // tid, so stoppedTid (1) no longer names a live thread. armAllStop then
    // interrupts the rest and sets stoppedTid to the thread that actually paused.
    const tid = this.#session.listTids()[0];
    if (tid === undefined) return;
    this.#armStopped();
    this.#session.armAllStop();
    this.#session.interrupt(tid);
    await this.#stopped;
    await this.#snapshotAll();
  }

  /**
   * Send an RDP interrupt to all running threads, then force-resolve the
   * pending #stopped promise so EventFuture.finish unblocks immediately.
   * Called when the user presses Ctrl-C while the target is running.
   *
   * The RDP interrupt and the "frames" request (from #snapshotAll) both go
   * into the same socket queue, so Firefox processes them in order: pause
   * first, then answer "frames" — giving us a real snapshot without waiting.
   */
  triggerInterrupt(): void {
    for (const tid of this.#session.listTids()) {
      try {
        this.#session.interrupt(tid);
      } catch {
        /* ignore unknown-tid errors */
      }
    }
    if (this.#resolveStopped) {
      this.#lastPauseReason = "signal";
      this.#resolveStopped({ tid: this.#session.stoppedTid, pausePacket: {} as PauseEvent });
      this.#resolveStopped = null;
      this.#rejectStopped = null;
    } else {
      this.#pendingInterrupt = true;
    }
  }

  #armStopped(): void {
    if (this.#pendingInterrupt) {
      this.#pendingInterrupt = false;
      this.#lastPauseReason = "signal";
      this.#stopped = Promise.resolve({
        tid: this.#session.stoppedTid,
        pausePacket: {} as PauseEvent,
      });
      this.#resolveStopped = null;
      this.#rejectStopped = null;
      return;
    }
    this.#stopped = new Promise((resolve, reject) => {
      this.#resolveStopped = resolve;
      this.#rejectStopped = reject;
    });
  }

  #clearResyncTimer(): void {
    if (this.#resyncTimer) {
      clearTimeout(this.#resyncTimer);
      this.#resyncTimer = null;
    }
  }

  /**
   * Called whenever a new top-level target arrives while a continue is
   * outstanding (#resolveStopped set — the process was running, or
   * continue() raced the navigation). LLDB is blocked in EventFuture.finish
   * waiting for a "stopped" that only a real RDP pause produces — which is
   * also the only point update_on_stop() -> all_modules() runs on the
   * component side: without one, a navigation to a page whose buffered
   * breakpoint never fires leaves LLDB attached to a stale module/thread
   * model with no way to learn otherwise.
   *
   * Give the new page a grace period to pause on its own — a buffered
   * breakpoint firing through the normal all-stop path (armAllStop's
   * onNewTarget listener) — before forcing it paused.
   *
   * Deliberately does NOT also force a pause when nothing is outstanding
   * (LLDB believes the debuggee is already stopped from before the swap,
   * gdbstub having no way to tell it otherwise): interrupting at an
   * arbitrary point can catch the new page between JS frames entirely
   * (idle, mid-microtask-checkpoint), and Firefox's own thread.js resume()
   * throws a bare TypeError ("frame is null") trying to single-step a
   * thread paused with no current frame — which is exactly what LLDB's own
   * step-off-a-stale-breakpoint dance tries to do on its next continue.
   * Left running instead, that dance's resume attempt fails with a
   * harmless, recoverable "wrongState" (thread not paused) and LLDB just
   * issues a normal continue afterward — worse information, but a thread
   * that's actually running, with an actual frame once it does hit
   * something, beats a "paused" thread Firefox can't safely single-step.
   */
  #scheduleResyncCheck(tid: number): void {
    this.#clearResyncTimer();
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      if (this.#resolveStopped === null) return; // LLDB isn't waiting on anything
      const live = this.#session.listTids();
      if (live.length === 0) return; // nothing left to interrupt — a genuine close, not a swap
      if (this.#session.hasUnwitnessedPause()) {
        // Adopts a pause that already happened (e.g. the new page's
        // breakpoint fired but nothing was listening yet) — its pausePacket
        // is synthetic and empty, so the "stopped" listener already
        // defaults its tag to "breakpoint"; no override needed. If instead
        // something IS paused but was properly witnessed (armAllStop's
        // onNewTarget already has a listener on it, #allStop is just still
        // running its interrupt-others phase), leave it alone rather than
        // racing a second #allStop against the one already in flight.
        void this.#session.adoptPausedState();
        return;
      }
      this.#forcingResyncStop = true;
      this.#session.interrupt(live.includes(tid) ? tid : live[0]);
    }, RESYNC_GRACE_MS);
  }

  // A navigation invalidates every actor/body these caches hold — they were
  // scoped to the destroyed top-level target. Clearing #moduleByUrl too (not
  // just the bytecode) means a same-URL reload gets a fresh module id: the
  // component treats it as a library unload+reload rather than serving the
  // old module's cached content, which is what makes a changed-body reload
  // (and, via the same path, a plain cross-page navigation) pick up correctly.
  #onNavigated(): void {
    this.#bytecodeByUrl.clear();
    this.#syntheticByUrl.clear();
    this.#sourceActorToUrl.clear();
    this.#moduleByUrl.clear();
    this.#moduleById.clear();
  }

  #eventFutureRef(): Ref {
    return { $res: "EventFuture", id: this.#nextId++ };
  }

  #eventTag(): string {
    switch (this.#lastPauseReason) {
      case "exception":
        return "trap";
      case "interrupted":
        return "interrupted";
      default:
        return "breakpoint";
    }
  }
}
