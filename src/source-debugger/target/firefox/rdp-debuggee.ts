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
// Sources discovered after attach are handled lazily from stopped call stacks.
// Sources already present at attach are preloaded before the component starts:
// a trap stop must stay SIGSEGV and therefore cannot also carry the RSP library
// notification LLDB would otherwise need to load a newly discovered synthetic
// module. Because #snapshotAll() runs inside EventFuture.finish (before the
// component's update_on_stop -> all_modules call), any later synthetic built
// from a breakpoint stack is present in addr_space before frame_to_pc runs.
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
import { createHash } from "node:crypto";
import type {
  RdpWasmSession,
  FrameForm,
  StoppedEvent,
  PauseEvent,
  ThreadInfo,
} from "./rdp/session.js";
import { buildSyntheticModule } from "../../../wasm/synthetic-debug-module.js";
import {
  inspect as inspectWasm,
  convert as convertSourceMap,
} from "../../../sourcemap/converter.js";
import { EMPTY_WASM_MODULE, RESYNC_GRACE_MS } from "./rdp/constants.js";
import { containedSourcePath } from "../../../sourcemap/materialize.js";
import { sanitizeSourceMapBytes, sourceMapDataUrlBytes } from "../../../sourcemap/input.js";
import { noopLogger, type Logger } from "../../../logging.js";
import { stripWasmNameSection, wasmFunctionRange } from "../../../wasm/bytecode.js";

function urlBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return basename(url) || "source.js";
}

function urlKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

const FOREIGN_FRAME_SOURCE = "__source_debugger_foreign__.wasm";

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

// Stop-coordination state for RdpDebuggee. Grouped under one field so a
// reader sees the whole cluster at once, but each property still has an
// independent lifetime managed at its own call sites — this is NOT a
// discriminated union with enforced transitions (see the fields' comments
// for cases where one property intentionally outlives another).
interface StopState {
  // Resolves on the next all-stop "stopped" event; rejects if the session
  // closes first. Awaited by #finishEvent/primeStop. Starts pre-resolved so
  // an early #finishEvent before any resume never hangs.
  promise: Promise<StoppedEvent>;
  // resolve/reject of `promise` while a stop is outstanding; null once it
  // has settled. Non-null iff we are actively waiting for a stop.
  pending: { resolve: (e: StoppedEvent) => void; reject: (e: Error) => void } | null;
  // RDP why.type (or a synthetic override) of the most-recently-delivered
  // stop; read only by #eventTag(). Only meaningful right after `promise`
  // settles.
  reason: string;
  // Set by the host Ctrl-C handler until Firefox delivers the corresponding
  // real pause. This can precede Debuggee.continue arming `promise` because
  // the SIGINT handler runs synchronously while WIT dispatch runs later.
  hostInterruptPending: boolean;
  // Set just before #scheduleResyncCheck forces a fresh RDP interrupt to
  // manufacture a stop. Firefox reports that pause's why.type as
  // "interrupted", which the component's Event::Interrupted arm treats as
  // spurious and just resumes from (it's meant for a real client Ctrl-C,
  // which this isn't). Override the tag to "breakpoint" for this one stop so
  // it lands in the arm that actually consults update_on_stop()'s changed
  // modules and reports MultiThreadStopReason::Library. Cleared wherever
  // `pending` settles or is bypassed (the "stopped" listener, session close,
  // triggerInterrupt()) so it never survives to mislabel a later,
  // unrelated stop.
  forcingResync: boolean;
  // A sibling component owns the physical stop. Complete this observer's
  // local operation on its active thread without presenting a breakpoint.
  forcingSynchronizeTid: number | undefined;
  // A sibling debugger owns a user-visible stop. Complete this local wait as a
  // breakpoint; any debugger-private frame used to terminate a source plan is
  // synthesized above this physical debuggee layer.
  forcingBreakpoint: boolean;
}

// One handler per WIT method, keyed "Interface.method" (matches dispatch()'s
// req.type + "." + req.method). A handler may take fewer params than this
// signature declares if it doesn't need id/args.
type Handler = (id: number, args: unknown[]) => unknown;

export type RdpDebuggeeResumeAction =
  | { kind: "continue" }
  | { kind: "step"; tid: number; limit: "step" | "next" };

// Optional interception point used when several debugger components observe
// one physical Firefox process. Each component arms its local gdbstub wait;
// run control decides which component may arm the shared RDP all-stop and
// release the physical pause lease.
export interface RdpDebuggeeRunControl {
  /** Hold a proposed physical resume until this debugger owns the shared run
   * lease. The component may refine the action before releasing it; LLDB
   * step-in uses instruction granularity at opaque JavaScript boundaries. */
  resume(
    action: RdpDebuggeeResumeAction,
    resumePhysicalTarget: (action: RdpDebuggeeResumeAction) => void
  ): void;
  installSynchronizeStop?(synchronize: (tid?: number) => void): void;
}

export class RdpDebuggee {
  #session: RdpWasmSession;
  #logger: Logger;
  #runControl: RdpDebuggeeRunControl | undefined;
  #acceptModule: (url: string, kind: "wasm" | "javascript") => boolean;
  #nextId = 1;

  // Stable module identity per source URL.
  #moduleByUrl = new Map<string, { id: number; url: string }>();
  #moduleById = new Map<number, { id: number; url: string }>();

  // Synthetic modules for JS sources: url -> {bytecode, codeOffset}.
  #syntheticByUrl = new Map<string, { bytecode: Uint8Array; codeOffset: number }>();

  // Foreign frames remain in the RSP call chain as opaque synthetic modules.
  // LLDB needs a valid activation to commit a stop owned by another debugger,
  // but must not load that module's real symbols or expose its source semantics.
  #opaqueUrlByForeignUrl = new Map<string, string>();
  #foreignModuleUrlByFrameActor = new Map<string, string>();

  // Cache of bytecode served to LLDB per wasm URL. For modules that ship a
  // source map instead of DWARF, this holds the source-map-derived bytecode.
  #bytecodeByUrl = new Map<string, Uint8Array>();

  // Temp dir for materialized JS source text (for LLDB source list).
  #tmpDir: string = mkdtempSync(join(tmpdir(), "firefox-wasm-debugger-"));

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

  #stop: StopState = {
    promise: Promise.resolve({ tid: 1, pausePacket: {} as PauseEvent }),
    pending: null,
    reason: "breakpoint",
    hostInterruptPending: false,
    forcingResync: false,
    forcingSynchronizeTid: undefined,
    forcingBreakpoint: false,
  };

  // Fired once on LLDB's first continue (drives the page's wasm export
  // after a breakpoint is armed, so the engine pauses inside wasm).
  #onFirstContinue: (() => void) | null = null;

  // Pending "force a re-sync stop if nothing paused naturally" check, armed
  // when a new top-level target arrives while a continue is outstanding (see
  // #scheduleResyncCheck).
  #resyncTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #handleStopped = (event: StoppedEvent): void => {
    this.#clearResyncTimer();
    const pending = this.#stop.pending;
    if (!pending) return;
    this.#stop.reason = this.#stop.hostInterruptPending
      ? "signal"
      : this.#stop.forcingBreakpoint || this.#stop.forcingResync
        ? "breakpoint"
        : ((event.pausePacket as { why?: { type?: string } })?.why?.type ?? "breakpoint");
    this.#stop.hostInterruptPending = false;
    this.#stop.forcingResync = false;
    this.#stop.forcingBreakpoint = false;
    pending.resolve(event);
    this.#stop.pending = null;
  };
  #handleSessionClose = (): void => {
    this.#clearResyncTimer();
    // Unblock any pending EventFuture.finish / primeStop so the gdbstub
    // worker thread doesn't hang when the RDP connection drops mid-session.
    this.#stop.pending?.reject(new Error("session closed"));
    this.#stop.pending = null;
    this.#stop.hostInterruptPending = false;
    this.#stop.forcingResync = false;
    this.#stop.forcingSynchronizeTid = undefined;
    this.#stop.forcingBreakpoint = false;
  };
  #handleNavigated = (): void => this.#onNavigated();
  #handleTarget = (info: ThreadInfo): void => {
    if (info.isTopLevel) this.#scheduleResyncCheck(info.tid);
  };
  #removeTempDir = (): void => {
    try {
      rmSync(this.#tmpDir, { recursive: true, force: true });
    } catch (err) {
      this.#logger.debug(
        `[cleanup] could not remove ${this.#tmpDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  constructor(
    session: RdpWasmSession,
    opts?: {
      onFirstContinue?: () => void;
      logger?: Logger;
      runControl?: RdpDebuggeeRunControl;
      moduleFilter?: (url: string, kind: "wasm" | "javascript") => boolean;
    }
  ) {
    this.#session = session;
    this.#logger = opts?.logger ?? noopLogger;
    this.#onFirstContinue = opts?.onFirstContinue ?? null;
    this.#runControl = opts?.runControl;
    this.#acceptModule = opts?.moduleFilter ?? (() => true);
    this.#runControl?.installSynchronizeStop?.((tid) => this.#synchronizeStop(tid));

    session.on("stopped", this.#handleStopped);
    session.on("close", this.#handleSessionClose);

    // A navigation (driven or page-triggered) invalidates every per-URL cache
    // below — the actors/bodies they hold belonged to the destroyed target.
    session.on("navigated", this.#handleNavigated);

    // Give the new page a chance to pause on its own (a buffered breakpoint
    // firing), then force it paused if it doesn't — see #scheduleResyncCheck.
    // This must not happen synchronously/immediately: a driven navigate()
    // is still awaiting Firefox's own navigateTo{waitForLoad:true} reply at
    // this point, which only arrives once the new page's `load` event fires
    // — interrupting the thread right now would freeze it before `load` can
    // ever fire, deadlocking that await forever.
    session.on("target", this.#handleTarget);

    process.once("exit", this.#removeTempDir);
  }

  /** Release per-attach filesystem and process-level resources. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearResyncTimer();
    this.#session.off("stopped", this.#handleStopped);
    this.#session.off("close", this.#handleSessionClose);
    this.#session.off("navigated", this.#handleNavigated);
    this.#session.off("target", this.#handleTarget);
    process.off("exit", this.#removeTempDir);
    this.#removeTempDir();
  }

  // One entry per WIT method. dispatch() is just the lookup; each handler
  // below is independently readable instead of one arm of a single switch.
  #handlers: Record<string, Handler> = {
    "Debuggee.allModules": () => this.#allModules(),
    "Debuggee.allInstances": () => this.#allInstances(),
    "Debuggee.listThreads": () => this.#session.listTids(),
    "Debuggee.stoppedThread": () => this.#session.stoppedTid,
    "Debuggee.exitFrames": (_id, args) => this.#exitFrames(args[0] as number),
    "Debuggee.continue": () => this.#doContinue(),
    "Debuggee.singleStep": (_id, args) => this.#doSingleStep(args[0] as number),
    "Debuggee.interrupt": () => this.#doInterrupt(),
    "EventFuture.finish": () => this.#finishEvent(),

    "Module.uniqueId": (id) => BigInt(id),
    "Module.name": (id) => this.#moduleName(id),
    "Module.bytecode": (id) => this.#moduleBytecode(id),
    "Module.addBreakpoint": (id, args) => this.#moduleAddBreakpoint(id, args[0] as number),
    "Module.removeBreakpoint": (id, args) => this.#moduleRemoveBreakpoint(id, args[0] as number),

    "Instance.getModule": (id) => this.#moduleRef(this.#instanceUrlById.get(id)!),
    "Instance.uniqueId": (id) => BigInt(this.#moduleByUrl.get(this.#instanceUrlById.get(id)!)!.id),
    "Instance.getMemory": (id, args) => this.#instanceGetMemory(id, args[0] as number),
    "Instance.getGlobal": (_id, args) => this.#instanceGetGlobal(args[0] as number),

    "Global.get": (id) => this.#readGlobal(this.#globalIndexById.get(id)!),
    "Global.uniqueId": (id) => BigInt(this.#globalIndexById.get(id)!),
    "Global.clone": (id) => this.#globalClone(id),

    "Memory.uniqueId": () => 1n,
    "Memory.sizeBytes": async () => BigInt(await this.#memorySize()),
    "Memory.pageSizeBytes": () => 65536n,
    "Memory.getBytes": (_id, args) =>
      this.#readMemory(Number(args[0] as bigint), Number(args[1] as bigint)),

    "Frame.getInstance": (id) => this.#frameInstance(id),
    "Frame.getFuncIndex": () => 0,
    "Frame.getPc": (id) => this.#frameGetPc(id),
    "Frame.getLocals": (id) => this.#localsForFrame(id),
    "Frame.getStack": () => [],
    "Frame.parentFrame": (id) => this.#parentFrame(id),

    "WasmValue.getType": (id) => this.#wasmValueGetType(id),
    "WasmValue.unwrapI32": (id) => this.#wasmValueUnwrapI32(id),
    "WasmValue.unwrapI64": (id) => this.#wasmValueUnwrapI64(id),
    "WasmValue.unwrapF32": (id) => this.#wasmValueUnwrapF(id),
    "WasmValue.unwrapF64": (id) => this.#wasmValueUnwrapF(id),
    "WasmValue.clone": (id) => this.#wasmValueClone(id),
  };

  dispatch(req: RpcRequest): unknown {
    const { type, id, method, args } = req;
    const key = `${type}.${method}`;
    const handler = this.#handlers[key];
    if (!handler) throw new Error(`RdpDebuggee: unhandled ${key}`);
    return handler(id, args);
  }

  // --- modules -------------------------------------------------------------
  async #allModules(): Promise<Ref[]> {
    // wasmSources() also keeps the session's actor->url mapping current.
    const wasmSources = await this.#session.wasmSources();
    for (const s of wasmSources.filter((source) => this.#acceptModule(source.url, "wasm"))) {
      this.#moduleRef(s.url);
    }
    // Return refs for all registered modules — wasm plus synthetic JS modules
    // preloaded at attach or built lazily during the last #snapshotAll. The
    // component calls allModules() after #snapshotAll() returns, so synthetics
    // built during that snapshot are already present here.
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

  // A navigation can clear #moduleById out from under a Module ref the
  // component is still holding (its own addr_space hasn't pruned it yet —
  // that only happens on the next stop's update_on_stop). Callers below
  // degrade gracefully instead of crashing the whole gdbstub worker on a WIT
  // call with no error case.
  #requireModule(id: number): { id: number; url: string } | undefined {
    return this.#moduleById.get(id);
  }

  #moduleName(id: number): string {
    const entry = this.#requireModule(id);
    if (!entry) return "<stale module>";
    // Suffix with the module id so a same-URL reload or a navigation back to
    // a previously-seen URL gets a name LLDB has never seen before. LLDB's
    // own library-list diff appears to key off this name string, not the
    // reported address: reusing a bare basename ("math.wasm") across two
    // different module incarnations reads to it as "the same library, still
    // loaded, nothing to do", so it never re-resolves breakpoints bound to
    // the one it already knew about — confirmed by tracing real RSP traffic
    // (its own Z0 rebind-attempt only ever retried the stale, pre-navigation
    // address once the name repeated, but correctly picked the new one once
    // the name differed).
    return `${urlBasename(entry.url)}#${id}`;
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
    } catch (err) {
      this.#logger.debug(
        `[sourcemap] could not inspect ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      return bytes;
    }
    // Embedded DWARF is authoritative for function names. Hide the wasm name
    // section from LLDB because its imported-function index handling otherwise
    // creates bogus duplicate symbols at later functions.
    if (info.hasDwarf) return stripWasmNameSection(bytes);
    if (!info.sourceMapUrl) return bytes;

    const mapUrl = info.sourceMapUrl;
    let mapBytes: Uint8Array | undefined;
    if (mapUrl.startsWith("data:")) {
      try {
        mapBytes = sourceMapDataUrlBytes(mapUrl);
      } catch (err) {
        this.#logger.warn(
          `[sourcemap] could not decode data URL for ${url}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return bytes;
      }
    } else {
      let resolved = mapUrl;
      try {
        resolved = new URL(mapUrl, url).href;
        const response = await fetch(resolved);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        mapBytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        this.#logger.warn(
          `[sourcemap] could not fetch ${resolved}: ${err instanceof Error ? err.message : String(err)}`
        );
        return bytes;
      }
    }

    try {
      mapBytes = sanitizeSourceMapBytes(mapBytes);
    } catch (err) {
      this.#logger.warn(
        `[sourcemap] invalid source map for ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return bytes;
    }

    const compDir = join(this.#tmpDir, `${urlBasename(url)}.${urlKey(url)}.src`);
    try {
      const res = await convertSourceMap(bytes, mapBytes, compDir);
      for (const sf of res.sources) {
        const dest = containedSourcePath(compDir, sf.path);
        if (!dest) {
          this.#logger.warn(`[sourcemap] refusing unsafe source path ${JSON.stringify(sf.path)}`);
          continue;
        }
        try {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, sf.content);
        } catch (err) {
          this.#logger.debug(
            `[sourcemap] could not materialize ${dest}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return res.wasm;
    } catch (err) {
      this.#logger.warn(
        `[sourcemap] conversion failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      return bytes;
    }
  }

  async #moduleBytecode(id: number): Promise<Uint8Array> {
    const entry = this.#requireModule(id);
    if (!entry) return EMPTY_WASM_MODULE;
    const syn = this.#syntheticByUrl.get(entry.url);
    return syn ? syn.bytecode : this.#wasmBytecode(entry.url);
  }

  async #moduleAddBreakpoint(id: number, pc: number): Promise<number> {
    const entry = this.#requireModule(id);
    if (!entry) return pc;
    const syn = this.#syntheticByUrl.get(entry.url);
    if (syn) {
      await this.#session.setJsBreakpoint(entry.url, pc - syn.codeOffset);
      return pc;
    } else {
      const bytes = await this.#moduleBytecode(id);
      const snapped = await this.#session.setWasmBreakpoint(
        entry.url,
        pc,
        wasmFunctionRange(bytes, pc)
      );
      return snapped;
    }
  }

  async #moduleRemoveBreakpoint(id: number, pc: number): Promise<null> {
    const entry = this.#requireModule(id);
    if (!entry) return null;
    const syn = this.#syntheticByUrl.get(entry.url);
    if (syn) {
      await this.#session.removeJsBreakpoint(entry.url, pc - syn.codeOffset);
    } else {
      await this.#session.removeWasmBreakpoint(entry.url, pc);
    }
    return null;
  }

  // --- instances -----------------------------------------------------------
  async #allInstances(): Promise<Ref[]> {
    const sources = await this.#session.wasmSources();
    const source = sources.find(({ url }) => this.#acceptModule(url, "wasm"));
    return source ? [this.#instanceRef(source.url)] : [];
  }

  #instanceGetMemory(id: number, memIndex: number): Ref | Promise<never> {
    const iUrl = this.#instanceUrlById.get(id)!;
    if (this.#syntheticByUrl.has(iUrl) || memIndex !== 0) {
      return Promise.reject(outOfBounds());
    }
    return { $res: "Memory", id: this.#nextId++ };
  }

  #instanceGetGlobal(globalIndex: number): Ref {
    const gid = this.#nextId++;
    this.#globalIndexById.set(gid, globalIndex);
    return { $res: "Global", id: gid };
  }

  // --- frames --------------------------------------------------------------
  async #snapshotAll(): Promise<void> {
    this.#frameInfoById.clear();
    this.#envCacheByActor.clear();
    this.#foreignModuleUrlByFrameActor.clear();
    const tids = this.#session.listTids();
    const snapshots = new Map<number, FrameForm[]>();

    // Firefox reports an empty frame list for pthread workers parked in
    // Atomics.wait. A host Ctrl-C initially targets a worker to start the
    // all-stop, but that worker may be one of those empty pool threads. Since
    // all-stop has paused every interruptible thread by this point, inspect
    // those paused workers until we find the live wasm stack the user expects
    // Ctrl-C to select.
    const candidates =
      this.#stop.reason === "signal" ? this.#session.pausedTids() : [this.#session.stoppedTid];
    let selectedTid = this.#session.stoppedTid;
    let fallbackTid: number | undefined;
    for (const tid of candidates) {
      const frames = await this.#snapshotFrames(tid);
      snapshots.set(tid, frames);
      if (frames.length > 0 && fallbackTid === undefined) fallbackTid = tid;
      if (frames.some((frame) => frame.type === "wasmcall")) {
        selectedTid = tid;
        break;
      }
    }
    if (!snapshots.get(selectedTid)?.length && fallbackTid !== undefined) selectedTid = fallbackTid;
    this.#session.selectStoppedTid(selectedTid);

    for (const tid of tids) {
      const frames = snapshots.get(tid) ?? [];
      this.#framesByTid.set(tid, frames);
      this.#topFrameActorByTid.set(
        tid,
        frames.find(
          (frame) =>
            frame.type === "wasmcall" &&
            !this.#foreignModuleUrlByFrameActor.has(frame.where?.actor ?? "")
        )?.actor ?? null
      );
    }
  }

  async #snapshotFrames(tid: number): Promise<FrameForm[]> {
    let candidates: FrameForm[];
    try {
      candidates = (await this.#session.frames(tid)).filter(
        (frame) => (frame.type === "wasmcall" || frame.type === "call") && frame.where
      );
    } catch {
      return [];
    }
    const frames: FrameForm[] = [];
    for (const frame of candidates) {
      const actor = frame.where!.actor;
      if (frame.type === "call" && this.#session.urlForSourceActor(actor) === undefined) {
        // Not yet known — jsSources() populates the session's actor->url
        // mapping as a side effect.
        await this.#session.jsSources();
      }
      const url = this.#session.urlForSourceActor(actor) ?? actor;
      if (!this.#acceptModule(url, frame.type === "call" ? "javascript" : "wasm")) {
        this.#ensureOpaqueForeignFrame(url, actor);
        frames.push(frame);
        continue;
      }
      if (frame.type === "call") {
        const calleeName = frame.callee?.displayName || frame.callee?.name;
        await this.#ensureSynthetic(url, actor, calleeName);
      }
      frames.push(frame);
    }
    return frames;
  }

  #ensureOpaqueForeignFrame(url: string, actor: string): void {
    let opaqueUrl = this.#opaqueUrlByForeignUrl.get(url);
    if (!opaqueUrl) {
      opaqueUrl = `source-debugger-foreign://${urlKey(url)}/${FOREIGN_FRAME_SOURCE}`;
      this.#opaqueUrlByForeignUrl.set(url, opaqueUrl);
      this.#syntheticByUrl.set(
        opaqueUrl,
        buildSyntheticModule({
          name: FOREIGN_FRAME_SOURCE,
          compDir: "/",
          lineCount: 1,
          subprogramName: "<foreign wasm frame>",
        })
      );
      this.#moduleRef(opaqueUrl);
    }
    this.#foreignModuleUrlByFrameActor.set(actor, opaqueUrl);
  }

  async #ensureSynthetic(url: string, actor: string, calleeName?: string): Promise<void> {
    if (this.#syntheticByUrl.has(url)) return;
    let text = "";
    try {
      text = await this.#session.fetchSourceText(actor);
    } catch {
      /* skip */
    }
    const lineCount = text ? text.split("\n").length : 1;
    const name = urlBasename(url);
    const sourceDir = join(this.#tmpDir, `${name}.${urlKey(url)}.src`);
    const filePath = join(sourceDir, name);
    if (text) {
      try {
        mkdirSync(sourceDir, { recursive: true });
        writeFileSync(filePath, text, "utf8");
      } catch (err) {
        this.#logger.debug(
          `[source] could not materialize ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
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

  // A trap must remain a SIGSEGV stop so LLDB exposes the fault correctly.
  // Unlike the breakpoint stop path, that signal stop cannot simultaneously
  // carry RSP's `library` notification, so a JS module first discovered in
  // the trapping stack would be added to the component's address space too
  // late for LLDB to load and symbolicate it (issue #45). Register the page's
  // current JS sources before the component performs its initial module scan.
  async #preloadJsSources(): Promise<void> {
    for (const source of (await this.#session.jsSources()).filter(({ url }) =>
      this.#acceptModule(url, "javascript")
    )) {
      await this.#ensureSynthetic(source.url, source.actor);
    }
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

  #frameGetPc(id: number): number {
    const fi = this.#frameInfoById.get(id);
    const frame = fi ? this.#framesByTid.get(fi.tid)?.[fi.index] : undefined;
    const line = frame?.where?.line ?? 0;
    const opaqueUrl = frame
      ? this.#foreignModuleUrlByFrameActor.get(frame.where?.actor ?? "")
      : undefined;
    if (opaqueUrl) return 1 + (this.#syntheticByUrl.get(opaqueUrl)?.codeOffset ?? 0);
    if (frame?.type === "call") {
      const url = this.#session.urlForSourceActor(frame.where!.actor) ?? frame.where!.actor;
      return line + (this.#syntheticByUrl.get(url)?.codeOffset ?? 0);
    }
    return line;
  }

  #frameInstance(frameId: number): Ref {
    const fi = this.#frameInfoById.get(frameId);
    const frames = fi ? (this.#framesByTid.get(fi.tid) ?? []) : [];
    const frame = fi ? frames[fi.index] : undefined;
    const actor = frame?.where?.actor ?? "";
    const url =
      this.#foreignModuleUrlByFrameActor.get(actor) ??
      this.#session.urlForSourceActor(actor) ??
      actor;
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
    if (
      !frame ||
      frame.type === "call" ||
      this.#foreignModuleUrlByFrameActor.has(frame.where?.actor ?? "")
    ) {
      return [];
    }
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

  #globalClone(id: number): Ref {
    const gid = this.#nextId++;
    this.#globalIndexById.set(gid, this.#globalIndexById.get(id)!);
    return { $res: "Global", id: gid };
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

  #wasmValueGetType(id: number): { tag: string } {
    const entry = this.#valueById.get(id);
    // Defensive: id not found → report funcref so value_to_bytes returns 0u32
    // rather than crashing with a null-deref (TypeScript ! assertion).
    return { tag: entry?.tag ?? "wasm-funcref" };
  }

  #wasmValueUnwrapI32(id: number): number {
    const entry = this.#valueById.get(id);
    return entry ? Number(entry.raw) >>> 0 : 0;
  }

  #wasmValueUnwrapI64(id: number): bigint {
    const entry = this.#valueById.get(id);
    return BigInt(entry?.raw ?? 0);
  }

  #wasmValueUnwrapF(id: number): number {
    const entry = this.#valueById.get(id);
    return Number(entry?.raw ?? 0);
  }

  #wasmValueClone(id: number): Ref {
    const v = this.#valueById.get(id);
    const newId = this.#nextId++;
    // Defensive: id not found → clone as zero i32 rather than crashing.
    this.#valueById.set(newId, v ?? { tag: "wasm-i32", raw: 0 });
    return { $res: "WasmValue", id: newId };
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
  #doContinue(): Ref {
    this.#armStopped();
    if (this.#stop.pending !== null) {
      if (this.#stop.hostInterruptPending) {
        // Ctrl-C won the race with WIT dispatch. Establish a genuine RDP
        // all-stop now and let the real worker pause resolve EventFuture.
        this.#session.armAllStop();
        this.#interruptForHost();
      } else if (this.#session.hasUnwitnessedPause()) {
        // A pause already happened with nothing listening for it — e.g. a
        // buffered breakpoint fired on a newly-navigated page before this
        // continue armed the all-stop machinery (armAllStop's paused:<tid>
        // listeners weren't registered yet). resumeAll() would resume
        // straight past that paused thread and nothing would stop again.
        // Surface the pause we already have instead of losing it. A tid
        // merely left over from an already-reported stop (e.g. primeStop's
        // initial interrupt) isn't one of these and takes the normal path.
        void this.#session.adoptPausedState().catch((err) => {
          this.#logger.error(
            `[rdp] could not adopt paused state: ${err instanceof Error ? err.message : String(err)}`
          );
          this.#session.close();
        });
      } else {
        const resume = (_action: RdpDebuggeeResumeAction) => {
          // Arm the physical all-stop only when run control grants this
          // component the resume lease. Observer components share the stop
          // event but must not install duplicate coordinators on one session.
          this.#session.armAllStop();
          this.#session.resumeAll().catch((err) => {
            this.#logger.error(
              `[rdp] resume failed: ${err instanceof Error ? err.message : String(err)}`
            );
            this.#session.close();
          });
          const cb = this.#onFirstContinue;
          this.#onFirstContinue = null;
          cb?.();
        };
        const action = { kind: "continue" } as const;
        if (this.#runControl) this.#runControl.resume(action, resume);
        else resume(action);
      }
    }
    return this.#eventFutureRef();
  }

  #doSingleStep(tid: number): Ref {
    this.#armStopped();
    if (this.#stop.pending !== null) {
      if (this.#stop.hostInterruptPending) {
        this.#session.armAllStop();
        this.#interruptForHost();
        return this.#eventFutureRef();
      }
      // LLDB's own "step off a stale breakpoint before resuming" dance —
      // triggered by its cached, pre-navigation view of where a breakpoint
      // site is — runs as a singleStep BEFORE it ever issues a real continue.
      // If a pause already happened with nothing listening (e.g. a buffered
      // breakpoint refiring on a newly-navigated page, won before this
      // step-off dance even started), stepping now would silently resume
      // straight past it. Surface it instead, same as #doContinue's check.
      if (this.#session.hasUnwitnessedPause()) {
        void this.#session.adoptPausedState().catch((err) => {
          this.#logger.error(
            `[rdp] could not adopt paused state: ${err instanceof Error ? err.message : String(err)}`
          );
          this.#session.close();
        });
        return this.#eventFutureRef();
      }
      // A JS (`call`) innermost frame is JIT-compiled: RDP "step" advances one
      // wasm instruction, which jumps an arbitrary number of JS source lines.
      // Use "next" (RDP step-over by source line) so a step lands on the next
      // JS line. This degrades JS step-in to step-over (single-subprogram
      // synthetic modules can't distinguish JS functions anyway).
      const innermost = this.#framesByTid.get(tid)?.[0];
      const proposedLimit = innermost?.type === "call" ? "next" : "step";
      const action = { kind: "step", tid, limit: proposedLimit } as const;
      const resume = (released: RdpDebuggeeResumeAction) => {
        const limit = released.kind === "step" ? released.limit : proposedLimit;
        this.#session.armAllStop();
        this.#session.stepOne(tid, limit);
      };
      if (this.#runControl) this.#runControl.resume(action, resume);
      else resume(action);
    }
    return this.#eventFutureRef();
  }

  #doInterrupt(): null {
    this.#armStopped();
    if (this.#stop.pending !== null) {
      this.#session.interrupt(this.#session.stoppedTid);
    }
    return null;
  }

  async #finishEvent(): Promise<{ tag: string; val?: number }> {
    await this.#stop.promise;
    await this.#snapshotAll();
    return this.#eventTag();
  }

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
    await this.#stop.promise;
    await this.#snapshotAll();
    await this.#preloadJsSources();
  }

  /**
   * Initialize a newly-created debugger projection from an already-paused
   * shared RDP session. Unlike primeStop(), this does not interrupt Firefox or
   * emit another physical stop.
   */
  async snapshotCurrentStop(): Promise<void> {
    if (!this.#session.paused()) {
      throw new Error("cannot snapshot a shared debuggee while it is running");
    }
    await this.#snapshotAll();
    await this.#preloadJsSources();
  }

  /** Request a genuine Firefox all-stop when the user presses Ctrl-C. */
  triggerInterrupt(): void {
    // A real interrupt supersedes any in-flight resync check: cancel it so
    // it can't later fire into an unrelated wait this triggerInterrupt() (or
    // whatever comes after it) arms. #clearResyncTimer() is a no-op if
    // nothing is armed.
    this.#clearResyncTimer();
    this.#stop.hostInterruptPending = true;
    this.#stop.forcingResync = false;
    this.#stop.forcingSynchronizeTid = undefined;
    if (this.#stop.pending) this.#interruptForHost();
  }

  /** Complete this projection's armed operation at a stop observed through a
   * sibling projection of the same physical debuggee. Public for the
   * transport-neutral WasmDebuggee resource; debugger-engine adapters decide
   * how that synchronized stop is presented to their engine. */
  synchronizeStop(tid?: number): void {
    this.#synchronizeStop(tid);
  }

  /** Complete an armed wait as an ordinary breakpoint at the already-shared
   * physical stop. A debugger-private sentinel frame, if needed, belongs in
   * that debugger's adapter rather than this physical debuggee. */
  breakpointStop(tid?: number): void {
    this.#breakpointStop(tid);
  }

  // Another debugger endpoint observed the physical stop. RDP reports a
  // breakpoint only to the connection which installed it, so manufacture a
  // local pause event for this endpoint while its LLDB is waiting. Marking it
  // as a forced synchronization makes gdbstub report a normal stop instead of
  // treating it as an LLDB-originated interrupt and silently resuming it.
  #synchronizeStop(tid?: number): void {
    if (!this.#stop.pending) return;
    this.#stop.forcingSynchronizeTid = tid ?? this.#session.stoppedTid;
    if (this.#session.paused()) {
      // The shared physical session has already witnessed the driver's stop.
      // Re-emit its current state for this observer; arming another all-stop
      // here would leave a stale pause listener behind for the next run.
      void this.#session.adoptPausedState().catch((error) => {
        this.#logger.error(
          `[rdp] could not synchronize shared stop: ${error instanceof Error ? error.message : String(error)}`
        );
        this.#session.close();
      });
      return;
    }

    // A legacy component on a separate RDP endpoint did not receive the
    // driver's connection-scoped breakpoint event. Force a local pause.
    this.#session.armAllStop();
    const interruptTid = this.#session.preferredInterruptTid();
    if (interruptTid !== undefined) this.#session.interrupt(interruptTid);
  }

  #breakpointStop(_tid?: number): void {
    if (!this.#stop.pending) return;
    this.#stop.forcingBreakpoint = true;
    this.#stop.forcingResync = false;
    if (this.#session.paused()) {
      void this.#session.adoptPausedState().catch((error) => {
        this.#logger.error(
          `[rdp] could not report shared breakpoint stop: ${error instanceof Error ? error.message : String(error)}`
        );
        this.#session.close();
      });
      return;
    }
    this.#session.armAllStop();
    const interruptTid = this.#session.preferredInterruptTid();
    if (interruptTid !== undefined) this.#session.interrupt(interruptTid);
  }

  #armStopped(): void {
    this.#stop.promise = new Promise((resolve, reject) => {
      this.#stop.pending = { resolve, reject };
    });
  }

  #interruptForHost(): void {
    const tid = this.#session.preferredInterruptTid();
    if (tid !== undefined) this.#session.interrupt(tid);
  }

  #clearResyncTimer(): void {
    if (this.#resyncTimer) {
      clearTimeout(this.#resyncTimer);
      this.#resyncTimer = null;
    }
  }

  /**
   * Called whenever a new top-level target arrives while a continue is
   * outstanding (#stop.pending set — the process was running, or
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
      if (this.#stop.pending === null) return; // LLDB isn't waiting on anything
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
        void this.#session.adoptPausedState().catch((err) => {
          this.#logger.error(
            `[rdp] could not adopt paused state: ${err instanceof Error ? err.message : String(err)}`
          );
          this.#session.close();
        });
        return;
      }
      this.#stop.forcingResync = true;
      this.#session.interrupt(live.includes(tid) ? tid : live[0]);
    }, RESYNC_GRACE_MS);
  }

  // A navigation invalidates every actor/body these caches hold — they were
  // scoped to the destroyed top-level target. (The session's own actor->url
  // map is cleared by session.ts itself, synchronously before this fires.)
  // Clearing #moduleByUrl too (not just the bytecode) means a same-URL reload
  // gets a fresh module id: the component treats it as a library unload+reload
  // rather than serving the old module's cached content, which is what makes a
  // changed-body reload (and, via the same path, a plain cross-page
  // navigation) pick up correctly.
  #onNavigated(): void {
    this.#bytecodeByUrl.clear();
    this.#syntheticByUrl.clear();
    this.#moduleByUrl.clear();
    this.#moduleById.clear();
    this.#opaqueUrlByForeignUrl.clear();
    this.#foreignModuleUrlByFrameActor.clear();
  }

  #eventFutureRef(): Ref {
    return { $res: "EventFuture", id: this.#nextId++ };
  }

  #eventTag(): { tag: string; val?: number } {
    const synchronizeTid = this.#stop.forcingSynchronizeTid;
    this.#stop.forcingSynchronizeTid = undefined;
    if (synchronizeTid !== undefined) return { tag: "synchronized", val: synchronizeTid };
    switch (this.#stop.reason) {
      case "exception":
        return { tag: "trap" };
      case "interrupted":
        return { tag: "interrupted" };
      default:
        // "signal" (triggerInterrupt's Ctrl-C) deliberately has no case of
        // its own here and falls through to "breakpoint". The component's
        // Event::Interrupted
        // arm only reports a real stop when its own Rust-side self.interrupt
        // flag is set — i.e. LLDB called the native Debuggee.interrupt WIT
        // method over RSP. A host-manufactured Ctrl-C never sets that, so
        // tagging it "interrupted" would make the component treat it as
        // spurious and silently resume instead of actually stopping.
        return { tag: "breakpoint" };
    }
  }
}
