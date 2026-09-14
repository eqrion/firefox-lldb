/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns WIT resources, generation-scoped symbols and per-thread stop snapshots.
// RDP owns execution; this adapter translates its observations into LLDB's
// address/value model. JS frames use synthetic modules alongside real wasm.
// See INTERNALS.md and docs/COMPATIBILITY.md for the integration contracts.

import { SourceFiles, sourceBasename } from "../symbols/source-files.js";
import type {
  RdpWasmSession,
  FrameForm,
  StoppedEvent,
  StopOperation,
  ThreadInfo,
  WasmSourceEvent,
} from "../rdp/session.js";
import { RetiredStopError } from "../rdp/session.js";
import { buildSyntheticModule } from "../symbols/synthetic-module.js";
import {
  inspect as inspectWasm,
  convert as convertSourceMap,
  valueMetadata,
} from "../sourcemap/converter.js";
import type {
  ModuleValues,
  ValueType,
} from "../sourcemap/generated/interfaces/firefox-lldb-source-map-source-map-converter.js";
import { PRIME_STOP_TIMEOUT_MS, RESYNC_GRACE_MS } from "../rdp/constants.js";
import type { DebugFileRegistry } from "../symbols/debug-files.js";
import { sanitizeSourceMapBytes, sourceMapDataUrlBytes } from "../symbols/source-map-input.js";
import { noopLogger, type Logger } from "../diagnostics/logger.js";
import { fetchBytes } from "../symbols/fetch.js";
import {
  stripWasmNameSection,
  wasmExternalDebugInfo,
  wasmFunctionRange,
} from "../symbols/wasm-bytecode.js";

export interface RpcRequest {
  type: string;
  id: number;
  method: string;
  args: unknown[];
}

// Bound allocation even when a client misinterprets the wasm address encoding.
const MAX_MEMORY_READ = 16 * 1024 * 1024;

function outOfBounds(): Error {
  return Object.assign(new Error("out-of-bounds"), { payload: "out-of-bounds" });
}

function unavailable(
  tag: "invalid-frame" | "invalid-entity" | "unsupported-type" | "breakpoint-update",
  cause?: unknown
): Error {
  return Object.assign(new Error(tag, { cause }), { payload: tag });
}

interface InstanceContext {
  url: string;
  frame?: { actor: string; tid: number; event: StoppedEvent };
}

type Ref = { $res: string; id: number };

// RDP owns execution completion; this adapter owns only LLDB stop labeling.
interface StopState {
  operation: StopOperation | null;
  reason: string;
  // A terminal Ctrl-C can arrive before the worker dispatches continue.
  hostInterruptPending: boolean;
  // A navigation resync must report a library change, not a spurious interrupt.
  forcingResync: boolean;
}

// One handler per WIT method, keyed "Interface.method" (matches dispatch()'s
// req.type + "." + req.method). A handler may take fewer params than this
// signature declares if it doesn't need id/args.
type Handler = (id: number, args: unknown[]) => unknown;

export class RdpDebuggee {
  #session: RdpWasmSession;
  #logger: Logger;
  #nextId = 1;

  // Stable module identity per source URL.
  #moduleByUrl = new Map<string, { id: number; url: string }>();
  #moduleById = new Map<number, { id: number; url: string }>();

  // Synthetic modules for JS sources: url -> {bytecode, codeOffset}.
  #syntheticByUrl = new Map<string, { bytecode: Uint8Array; codeOffset: number }>();

  // Cache of bytecode served to LLDB per wasm URL. For modules that ship a
  // source map instead of DWARF, this holds the source-map-derived bytecode.
  #bytecodeByUrl = new Map<string, Uint8Array>();

  // Where a module's separate DWARF file is registered for LLDB to open.
  #debugFiles?: DebugFileRegistry;

  #sourceFiles: SourceFiles;

  // Per-tid frame snapshots (innermost-first wasm+JS frames, set on each stop).
  #framesByTid = new Map<number, FrameForm[]>();
  #snapshotEvent?: StoppedEvent;
  #unavailableFrames = new Map<number, string>();

  // Frame ref id -> {tid, index} (reset on each stop).
  #frameInfoById = new Map<number, { tid: number; index: number }>();

  // Instance handles retain their module and, when available, requesting frame.
  #instances = new Map<number, InstanceContext>();
  #metadataByUrl = new Map<string, ModuleValues>();
  #memoryById = new Map<number, string>();
  #memoryModuleUrl?: string;

  // WasmValue refs (id -> {tag, raw}); raw is the JS value from RDP bindings.
  #valueById = new Map<number, { tag: string; raw: number | bigint }>();

  // Global handles retain the requesting instance, index and clone identity.
  #globals = new Map<number, { index: number; instance: InstanceContext; uniqueId: bigint }>();
  #futureById = new Map<number, StopOperation>();

  // One environment fetch serves all local reads for this frame and stop.
  #envCacheByActor = new Map<string, Record<string, { value?: unknown }>>();

  #stop: StopState = {
    operation: null,
    reason: "breakpoint",
    hostInterruptPending: false,
    forcingResync: false,
  };

  // Fired once on LLDB's first continue (drives the page's wasm export
  // after a breakpoint is armed, so the engine pauses inside wasm).
  #onFirstContinue: (() => void) | null = null;

  // Pending "force a re-sync stop if nothing paused naturally" check, armed
  // when a new top-level target arrives while a continue is outstanding (see
  // #scheduleResyncCheck).
  #resyncTimer: ReturnType<typeof setTimeout> | null = null;
  #resyncTid: number | undefined;
  #disposed = false;
  #generation = new AbortController();
  #unsubscribe: (() => void)[] = [];
  constructor(
    session: RdpWasmSession,
    opts?: { onFirstContinue?: () => void; logger?: Logger; debugFiles?: DebugFileRegistry }
  ) {
    this.#session = session;
    this.#logger = opts?.logger ?? noopLogger;
    this.#sourceFiles = new SourceFiles(this.#logger);
    this.#onFirstContinue = opts?.onFirstContinue ?? null;
    this.#debugFiles = opts?.debugFiles;

    const onStopped = (e: StoppedEvent) => {
      if (this.#stop.operation?.id !== e.stopId) return;
      this.#clearResync();
      this.#stop.reason = this.#stop.hostInterruptPending
        ? "signal"
        : this.#stop.forcingResync
          ? "breakpoint"
          : ((e.pausePacket as { why?: { type?: string } })?.why?.type ?? "breakpoint");
      this.#stop.hostInterruptPending = false;
      this.#stop.forcingResync = false;
    };
    session.on("stopped", onStopped);
    this.#unsubscribe.push(() => session.off("stopped", onStopped));

    const onClose = () => {
      this.#generation.abort(new Error("debuggee session closed"));
      this.#clearResync();
      // Unblock any pending EventFuture.finish / primeStop so the gdbstub
      // worker thread doesn't hang when the RDP connection drops mid-session.
      this.#stop.operation?.cancel(new Error("session closed"));
      this.#stop.hostInterruptPending = false;
      this.#stop.forcingResync = false;
    };
    session.on("close", onClose);
    this.#unsubscribe.push(() => session.off("close", onClose));

    // A navigation (driven or page-triggered) invalidates every per-URL cache
    // below — the actors/bodies they hold belonged to the destroyed target.
    const onNavigated = () => this.#onNavigated();
    session.on("navigated", onNavigated);
    this.#unsubscribe.push(() => session.off("navigated", onNavigated));

    // Give the new page a chance to pause on its own (a buffered breakpoint
    // firing), then force it paused if it doesn't — see #scheduleResyncCheck.
    // This must not happen synchronously/immediately: give buffered
    // breakpoints on the replacement page a chance to fire through the normal
    // all-stop path before forcing the new target to stop.
    const onTarget = (info: ThreadInfo) => {
      if (info.isTopLevel) this.#scheduleResyncCheck(info.tid);
    };
    session.on("target", onTarget);
    this.#unsubscribe.push(() => session.off("target", onTarget));

    // Compilation may finish after the target's initial resync found no wasm.
    // Announce that later module through a real stop and a fresh source query.
    const onWasmSource = ({ thread, url }: WasmSourceEvent) => {
      if (
        thread.isTopLevel &&
        thread.generation === session.topLevelGeneration() &&
        !this.#moduleByUrl.has(url)
      ) {
        this.#logger.debug(
          `[debuggee] module-discovered generation=${thread.generation} tid=${thread.tid} url=${url}`
        );
        this.#scheduleResyncCheck(thread.tid);
      }
    };
    session.on("wasm-source", onWasmSource);
    this.#unsubscribe.push(() => session.off("wasm-source", onWasmSource));

    this.logState("created");
  }

  /** Resource counts and filesystem ownership, without changing execution state. */
  logState(event = "snapshot"): void {
    this.#logger.debug(
      `[debuggee] ${event} ${JSON.stringify({
        disposed: this.#disposed,
        generation: this.#session.topLevelGeneration(),
        tempDir: this.#sourceFiles.root,
        modules: this.#moduleById.size,
        bytecodes: this.#bytecodeByUrl.size,
        syntheticModules: this.#syntheticByUrl.size,
        frameHandles: this.#frameInfoById.size,
        instanceHandles: this.#instances.size,
        valueHandles: this.#valueById.size,
        globalHandles: this.#globals.size,
        futureHandles: this.#futureById.size,
        memoryHandles: this.#memoryById.size,
        valueMetadata: this.#metadataByUrl.size,
      })}`
    );
  }

  /** Release per-attach filesystem and process-level resources. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop.operation?.cancel(new Error("debuggee disposed"));
    this.#generation.abort(new Error("debuggee disposed"));
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#clearResync();
    for (const map of [
      this.#moduleByUrl,
      this.#moduleById,
      this.#bytecodeByUrl,
      this.#syntheticByUrl,
      this.#framesByTid,
      this.#unavailableFrames,
      this.#frameInfoById,
      this.#envCacheByActor,
      this.#instances,
      this.#valueById,
      this.#metadataByUrl,
      this.#memoryById,
      this.#globals,
      this.#futureById,
    ])
      map.clear();
    this.#sourceFiles.close();
    this.logState("disposed");
  }

  // Dispatch validates resource ownership before invoking a WIT method.
  #handlers: Record<string, Handler> = {
    "Debuggee.allModules": () => this.#allModules(),
    "Debuggee.allInstances": () => this.#allInstances(),
    "Debuggee.listThreads": () => this.#session.listTids(),
    "Debuggee.stoppedThread": () => this.#session.stoppedTid,
    "Debuggee.exitFrames": (_id, args) => this.#exitFrames(args[0] as number),
    "Debuggee.continue": () => this.#doContinue(),
    "Debuggee.singleStep": (_id, args) => this.#doSingleStep(args[0] as number),
    "Debuggee.interrupt": () => this.#doInterrupt(),
    "EventFuture.finish": (id) => this.#finishEvent(id),

    "Module.uniqueId": (id) => BigInt(id),
    "Module.name": (id) => this.#moduleName(id),
    "Module.bytecode": (id) => this.#moduleBytecode(id),
    "Module.addBreakpoint": (id, args) => this.#moduleAddBreakpoint(id, args[0] as number),
    "Module.removeBreakpoint": (id, args) => this.#moduleRemoveBreakpoint(id, args[0] as number),

    "Instance.getModule": (id) => this.#moduleRef(this.#instances.get(id)!.url),
    "Instance.uniqueId": (id) => BigInt(this.#moduleByUrl.get(this.#instances.get(id)!.url)!.id),
    "Instance.getMemory": (id, args) => this.#instanceGetMemory(id, args[0] as number),
    "Instance.getGlobal": (id, args) => this.#instanceGetGlobal(id, args[0] as number),

    "Global.get": (id) => this.#readGlobal(id),
    "Global.uniqueId": (id) => this.#globals.get(id)!.uniqueId,
    "Global.clone": (id) => this.#globalClone(id),

    "Memory.uniqueId": (id) => BigInt(this.#moduleByUrl.get(this.#memoryById.get(id)!)!.id),
    "Memory.sizeBytes": async (id) => BigInt(await this.#memorySize(id)),
    "Memory.pageSizeBytes": () => 65536n,
    "Memory.getBytes": (id, args) =>
      this.#readMemory(id, Number(args[0] as bigint), Number(args[1] as bigint)),

    "Frame.getInstance": (id) => this.#frameInstance(id),
    "Frame.getPc": (id) => this.#frameGetPc(id),
    "Frame.getLocal": (id, args) => this.#localForFrame(id, args[0] as number),
    "Frame.getStack": () => {
      throw unavailable("unsupported-type");
    },
    "Frame.parentFrame": (id) => this.#parentFrame(id),

    "WasmValue.getType": (id) => this.#wasmValueGetType(id),
    "WasmValue.unwrapI32": (id) => this.#wasmValueUnwrapI32(id),
    "WasmValue.unwrapI64": (id) => this.#wasmValueUnwrapI64(id),
    "WasmValue.unwrapF32": (id) => this.#wasmValueUnwrapF(id),
    "WasmValue.unwrapF64": (id) => this.#wasmValueUnwrapF(id),
    "WasmValue.clone": (id) => this.#wasmValueClone(id),
  };

  dispatch(req: RpcRequest): unknown {
    if (this.#disposed) throw new Error("debuggee disposed");
    const { type, id, method, args } = req;
    if (method === "drop") {
      switch (type) {
        case "Frame":
          this.#frameInfoById.delete(id);
          break;
        case "Instance":
          this.#instances.delete(id);
          break;
        case "Global":
          this.#globals.delete(id);
          break;
        case "WasmValue":
          this.#valueById.delete(id);
          break;
        // Modules belong to the generation's catalog, not an individual proxy.
        case "EventFuture":
          this.#futureById.get(id)?.cancel(new Error("execution future dropped"));
          this.#futureById.delete(id);
          break;
        case "Module":
          break;
        case "Memory":
          this.#memoryById.delete(id);
          break;
        default:
          throw new Error(`cannot drop unknown resource ${type}`);
      }
      return null;
    }
    const resources =
      type === "Frame"
        ? this.#frameInfoById
        : type === "Instance"
          ? this.#instances
          : type === "Global"
            ? this.#globals
            : type === "WasmValue"
              ? this.#valueById
              : type === "EventFuture"
                ? this.#futureById
                : type === "Memory"
                  ? this.#memoryById
                  : undefined;
    if (resources && !resources.has(id)) {
      const tag = type === "Frame" ? "invalid-frame" : "invalid-entity";
      throw Object.assign(new Error(tag), { payload: tag });
    }
    const key = `${type}.${method}`;
    const handler = this.#handlers[key];
    if (!handler) throw new Error(`RdpDebuggee: unhandled ${key}`);
    // A retired read is an unavailable observation, not an unexpected host bug.
    // Preserve every other exception for the worker's fatal-error boundary.
    const classify = (error: unknown): never => {
      if (error instanceof RetiredStopError) throw unavailable("invalid-frame", error);
      throw error;
    };
    try {
      const result = handler(id, args);
      return result instanceof Promise ? result.catch(classify) : result;
    } catch (error) {
      return classify(error);
    }
  }

  // --- modules -------------------------------------------------------------
  async #allModules(): Promise<Ref[]> {
    const { signal } = this.#generation;
    // wasmSources() also keeps the session's actor->url mapping current.
    const wasmSources = await this.#session.wasmSources();
    signal.throwIfAborted();
    for (const s of wasmSources) {
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
      if (this.#moduleByUrl.size >= 4096) throw new Error("module catalog exceeds 4096 entries");
      m = { id: this.#nextId++, url };
      this.#moduleByUrl.set(url, m);
      this.#moduleById.set(m.id, m);
    }
    return { $res: "Module", id: m.id };
  }

  // The component can retain old module proxies until its next stop update.
  // Missing bytecode stays absent; old proxies cannot identify a new module.
  #requireModule(id: number): { id: number; url: string } | undefined {
    return this.#moduleById.get(id);
  }

  #moduleName(id: number): string {
    const entry = this.#requireModule(id);
    if (!entry) return "<stale module>";
    // LLDB's library diff uses names; an incarnation suffix makes same-URL
    // reloads rebind their breakpoints. See nav_reload.test.mjs.
    return `${sourceBasename(entry.url)}#${id}`;
  }

  // Fetch a real wasm module's bytecode, attaching debug info the module only
  // points at (separate DWARF, source maps) so it is debuggable. Cached per URL.
  async #wasmBytecode(url: string): Promise<Uint8Array | undefined> {
    const { signal } = this.#generation;
    signal.throwIfAborted();
    const cached = this.#bytecodeByUrl.get(url);
    if (cached) return cached;
    const bytes = await this.#session.fetchModuleBytes(url);
    signal.throwIfAborted();
    if (!bytes) return undefined;
    const out = await this.#withDebugInfo(url, bytes, signal);
    signal.throwIfAborted();
    this.#checkSymbolBudget(out.length);
    this.#bytecodeByUrl.set(url, out);
    return out;
  }

  #checkSymbolBudget(bytes: number): void {
    for (const value of this.#bytecodeByUrl.values()) bytes += value.length;
    for (const value of this.#syntheticByUrl.values()) bytes += value.bytecode.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("symbol bytecode cache exceeds 128 MiB limit");
  }

  #allocateHandle(): number {
    const count =
      this.#frameInfoById.size +
      this.#instances.size +
      this.#globals.size +
      this.#valueById.size +
      this.#memoryById.size +
      this.#futureById.size;
    if (count >= 65536) throw new Error("debugger resource handle limit of 65536 exceeded");
    return this.#nextId++;
  }

  // Enrich real bytes with optional symbols. Enrichment failure retains the
  // original bytes; generation cancellation still rejects the operation.
  async #withDebugInfo(url: string, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    let info;
    try {
      info = await inspectWasm(bytes);
      signal.throwIfAborted();
    } catch (err) {
      signal.throwIfAborted();
      this.#logger.debug(
        `[sourcemap] could not inspect ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      return bytes;
    }
    // Embedded DWARF is authoritative for function names. Hide the wasm name
    // section from LLDB because its imported-function index handling otherwise
    // creates bogus duplicate symbols at later functions.
    if (info.hasDwarf) return stripWasmNameSection(bytes);

    const externalDebugInfo = wasmExternalDebugInfo(bytes);
    if (externalDebugInfo) {
      // The DWARF arrives later, when LLDB opens the companion file. Keep the
      // name section: until then (or if the file cannot be fetched) it carries
      // the only symbols this module has, and LLDB prefers DWARF once loaded.
      this.#debugFiles?.register(externalDebugInfo, url, signal);
      return bytes;
    }

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
        mapBytes = await fetchBytes(resolved, { maxBytes: 31 * 1024 * 1024, signal });
      } catch (err) {
        signal.throwIfAborted();
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

    const compDir = this.#sourceFiles.directory(url, signal);
    try {
      const res = await convertSourceMap(bytes, mapBytes, compDir);
      signal.throwIfAborted();
      for (const sf of res.sources) {
        try {
          this.#sourceFiles.write(url, sf.path, sf.content, signal);
        } catch (err) {
          signal.throwIfAborted();
          this.#logger.warn(`[source] could not materialize ${JSON.stringify(sf.path)}: ${err}`);
        }
      }
      return res.wasm;
    } catch (err) {
      this.#logger.warn(
        `[sourcemap] conversion failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      signal.throwIfAborted();
      return bytes;
    }
  }

  async #moduleBytecode(id: number): Promise<Uint8Array | undefined> {
    const entry = this.#requireModule(id);
    if (!entry) return undefined;
    const syn = this.#syntheticByUrl.get(entry.url);
    return syn ? syn.bytecode : this.#wasmBytecode(entry.url);
  }

  async #moduleAddBreakpoint(id: number, pc: number): Promise<number> {
    const entry = this.#requireModule(id);
    try {
      if (!entry) throw new Error("breakpoint module retired");
      const { signal } = this.#generation;
      const syn = this.#syntheticByUrl.get(entry.url);
      if (syn) {
        const line = await this.#session.setJsBreakpoint(entry.url, pc - syn.codeOffset);
        signal.throwIfAborted();
        return line + syn.codeOffset;
      }
      const bytes = await this.#moduleBytecode(id);
      if (!bytes) throw unavailable("breakpoint-update");
      signal.throwIfAborted();
      const snapped = await this.#session.setWasmBreakpoint(
        entry.url,
        pc,
        wasmFunctionRange(bytes, pc)
      );
      signal.throwIfAborted();
      return snapped;
    } catch (cause) {
      this.#logger.error(`[breakpoints] add module=${id} pc=${pc}: ${String(cause)}`);
      const error = new Error("breakpoint-update", { cause }) as Error & { payload: string };
      error.payload = "breakpoint-update";
      throw error;
    }
  }

  async #moduleRemoveBreakpoint(id: number, pc: number): Promise<null> {
    const entry = this.#requireModule(id);
    if (!entry) return null;
    const { signal } = this.#generation;
    try {
      const syn = this.#syntheticByUrl.get(entry.url);
      if (syn) await this.#session.removeJsBreakpoint(entry.url, pc - syn.codeOffset);
      else await this.#session.removeWasmBreakpoint(entry.url, pc);
      signal.throwIfAborted();
    } catch (cause) {
      this.#logger.error(`[breakpoints] remove module=${id} pc=${pc}: ${String(cause)}`);
      throw unavailable("breakpoint-update", cause);
    }
    return null;
  }

  // --- instances -----------------------------------------------------------
  async #allInstances(): Promise<Ref[]> {
    const { signal } = this.#generation;
    const sources = await this.#session.wasmSources();
    signal.throwIfAborted();
    this.#memoryModuleUrl ??= sources[0]?.url;
    return this.#memoryModuleUrl ? [this.#instanceRef(this.#memoryModuleUrl)] : [];
  }

  async #instanceGetMemory(id: number, memIndex: number): Promise<Ref> {
    const instance = this.#instances.get(id)!;
    if (
      this.#syntheticByUrl.has(instance.url) ||
      memIndex !== 0 ||
      instance.url !== this.#memoryModuleUrl
    ) {
      throw outOfBounds();
    }
    const metadata = await this.#valueMetadata(instance.url);
    if (metadata.memories !== 1) throw unavailable("unsupported-type");
    const memoryId = this.#allocateHandle();
    this.#memoryById.set(memoryId, instance.url);
    return { $res: "Memory", id: memoryId };
  }

  #instanceGetGlobal(id: number, globalIndex: number): Ref {
    const instance = this.#instances.get(id)!;
    if (!instance.frame) throw unavailable("invalid-frame");
    this.#session.assertStopped(instance.frame.event);
    if (!Number.isSafeInteger(globalIndex) || globalIndex < 0) throw outOfBounds();
    const gid = this.#allocateHandle();
    this.#globals.set(gid, { index: globalIndex, instance, uniqueId: BigInt(gid) });
    return { $res: "Global", id: gid };
  }

  // --- frames --------------------------------------------------------------
  async #snapshotStopped(event: StoppedEvent): Promise<void> {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        await this.#snapshotAll(event);
        return;
      } catch (error) {
        if (
          !(error instanceof RetiredStopError) ||
          Date.now() >= deadline ||
          !this.#session.canExtendStop(event)
        )
          throw error;
        // Only target-set growth can retry a snapshot. A resume, navigation,
        // transport failure, or malformed response remains a failed operation.
        this.#armStopped();
        await this.#session.adoptPausedState();
        event = await this.#stop.operation!.promise;
      }
    }
  }

  async #snapshotAll(event: StoppedEvent): Promise<void> {
    const { signal } = this.#generation;
    this.#session.assertStopped(event);
    this.#frameInfoById.clear();
    this.#envCacheByActor.clear();
    const tids = event.pausedTids;
    const snapshots = new Map<number, FrameForm[]>();
    const unavailable = new Map<number, string>();

    // A futex-blocked interrupt target may have no inspectable frames. Prefer a
    // paused peer with a live wasm stack without changing the stop's paused set.
    let selectedTid = this.#session.stoppedTid;
    let selectedWasm = false;
    let fallbackTid: number | undefined;
    for (const tid of tids) {
      let frames: FrameForm[];
      try {
        frames = await this.#snapshotFrames(tid);
      } catch (error) {
        // Firefox cannot serialize some wasm frames suspended in Atomics.wait.
        // Retain this as unavailable, not an observed empty stack.
        if (!(error instanceof Error) || error.message !== "TypeError: invalid script offset")
          throw error;
        unavailable.set(tid, error.message);
        this.#logger.debug(
          `[debuggee] frames-unavailable stop=${event.stopId} tid=${tid}: ${error.message}`
        );
        frames = [];
      }
      signal.throwIfAborted();
      this.#session.assertStopped(event);
      snapshots.set(tid, frames);
      if (frames.length > 0 && fallbackTid === undefined) fallbackTid = tid;
      if (
        this.#stop.reason === "signal" &&
        !selectedWasm &&
        frames.some((frame) => frame.type === "wasmcall")
      ) {
        selectedTid = tid;
        selectedWasm = true;
      }
    }
    if (
      this.#stop.reason === "signal" &&
      !snapshots.get(selectedTid)?.length &&
      fallbackTid !== undefined
    )
      selectedTid = fallbackTid;
    this.#session.assertStopped(event);
    this.#session.selectStoppedTid(selectedTid);

    this.#framesByTid.clear();
    this.#unavailableFrames = unavailable;
    this.#snapshotEvent = event;
    for (const tid of tids) {
      const frames = snapshots.get(tid) ?? [];
      this.#framesByTid.set(tid, frames);
    }
    this.logState("stop-snapshot");
  }

  async #snapshotFrames(tid: number): Promise<FrameForm[]> {
    const { signal } = this.#generation;
    const frames = (await this.#session.frames(tid)).filter(
      (frame) => (frame.type === "wasmcall" || frame.type === "call") && frame.where
    );
    signal.throwIfAborted();
    for (const frame of frames) {
      if (frame.type !== "call") continue;
      const actor = frame.where!.actor;
      if (this.#session.urlForSourceActor(actor) === undefined) {
        // Not yet known — jsSources() populates the session's actor->url
        // mapping as a side effect.
        await this.#session.jsSources();
        signal.throwIfAborted();
      }
      const url = this.#session.urlForSourceActor(actor) ?? actor;
      const calleeName = frame.callee?.displayName || frame.callee?.name;
      await this.#ensureSynthetic(url, actor, calleeName);
      signal.throwIfAborted();
    }
    return frames;
  }

  async #ensureSynthetic(url: string, actor: string, calleeName?: string): Promise<void> {
    const { signal } = this.#generation;
    signal.throwIfAborted();
    if (this.#syntheticByUrl.has(url)) return;
    let text = "";
    try {
      text = await this.#session.fetchSourceText(actor);
    } catch (error) {
      signal.throwIfAborted();
      this.#logger.warn(`[source] source text unavailable for ${url}: ${error}`);
    }
    signal.throwIfAborted();
    const lineCount = text ? text.split("\n").length : 1;
    const name = sourceBasename(url);
    const sourceDir = this.#sourceFiles.directory(url, signal);
    if (text) {
      try {
        this.#sourceFiles.write(url, name, text, signal);
      } catch (err) {
        signal.throwIfAborted();
        this.#logger.warn(`[source] could not materialize ${url}: ${err}`);
      }
    }
    const syn = buildSyntheticModule({
      name,
      compDir: sourceDir,
      lineCount,
      subprogramName: calleeName,
    });
    this.#checkSymbolBudget(syn.bytecode.length);
    this.#syntheticByUrl.set(url, syn);
    this.#moduleRef(url);
  }

  // Preload JS symbols before the initial module scan: a SIGSEGV trap cannot
  // also carry the library-change notification. See wasm_trap.test.mjs.
  async #preloadJsSources(): Promise<void> {
    const { signal } = this.#generation;
    for (const source of await this.#session.jsSources()) {
      signal.throwIfAborted();
      await this.#ensureSynthetic(source.url, source.actor);
    }
  }

  async #exitFrames(tid: number): Promise<Ref[]> {
    if (this.#unavailableFrames.has(tid)) {
      const error = new Error("invalid-frame") as Error & { payload: string };
      error.payload = "invalid-frame";
      throw error;
    }
    const frames = this.#framesByTid.get(tid) ?? [];
    return frames.length ? [this.#frameRef(tid, 0)] : [];
  }

  #frameRef(tid: number, index: number): Ref {
    const id = this.#allocateHandle();
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
    if (!this.#snapshotEvent) throw unavailable("invalid-frame");
    this.#session.assertStopped(this.#snapshotEvent);
    const fi = this.#frameInfoById.get(id);
    const frame = fi ? this.#framesByTid.get(fi.tid)?.[fi.index] : undefined;
    const line = frame?.where?.line ?? 0;
    if (frame?.type === "call") {
      const url = this.#session.urlForSourceActor(frame.where!.actor) ?? frame.where!.actor;
      return line + (this.#syntheticByUrl.get(url)?.codeOffset ?? 0);
    }
    return line;
  }

  #frameInstance(frameId: number): Ref {
    if (!this.#snapshotEvent) throw unavailable("invalid-frame");
    this.#session.assertStopped(this.#snapshotEvent);
    const fi = this.#frameInfoById.get(frameId);
    const frames = fi ? (this.#framesByTid.get(fi.tid) ?? []) : [];
    const frame = fi ? frames[fi.index] : undefined;
    const actor = frame?.where?.actor ?? "";
    const url = this.#session.urlForSourceActor(actor) ?? actor;
    if (!frame || !fi || !this.#snapshotEvent) throw unavailable("invalid-frame");
    return this.#instanceRef(url, { actor: frame.actor, tid: fi.tid, event: this.#snapshotEvent });
  }

  #instanceRef(url: string, frame?: InstanceContext["frame"]): Ref {
    this.#moduleRef(url);
    const id = this.#allocateHandle();
    this.#instances.set(id, { url, frame });
    return { $res: "Instance", id };
  }

  // --- locals / memory -----------------------------------------------------
  async #localForFrame(frameId: number, index: number): Promise<Ref> {
    const { signal } = this.#generation;
    const event = this.#snapshotEvent;
    const fi = this.#frameInfoById.get(frameId);
    if (!fi || !event) throw unavailable("invalid-frame");
    this.#session.assertStopped(event);
    const frames = this.#framesByTid.get(fi.tid) ?? [];
    const frame = frames[fi.index];
    if (!frame) throw unavailable("invalid-frame");
    if (frame.type === "call") throw unavailable("invalid-frame");
    if (!Number.isSafeInteger(index) || index < 0) throw outOfBounds();
    const url = this.#session.urlForSourceActor(frame.where!.actor);
    if (!url) throw unavailable("invalid-frame");
    const metadata = await this.#valueMetadata(url);
    signal.throwIfAborted();
    this.#session.assertStopped(event);
    const types = metadata.functions.find(
      (fn) => fn.start <= frame.where!.line && frame.where!.line < fn.end
    )?.locals;
    if (!types) throw unavailable("invalid-frame");
    type VarBindings = Record<string, { value?: unknown }>;
    if (!this.#envCacheByActor.has(frame.actor)) {
      // Reuse this stop's environment across individual qWasmLocal requests.
      const env = (await this.#session.frameEnvironment(frame.actor)) as {
        bindings?: { variables?: VarBindings };
      };
      signal.throwIfAborted();
      this.#session.assertStopped(event);
      if (!env.bindings?.variables) throw unavailable("invalid-frame");
      this.#envCacheByActor.set(frame.actor, env.bindings.variables);
    }
    const vars = this.#envCacheByActor.get(frame.actor)!;
    return this.#valueRef(vars[`var${index}`]?.value, types[index]);
  }

  async #readGlobal(id: number): Promise<Ref> {
    const { index, instance } = this.#globals.get(id)!;
    const vars = await this.#instanceScopeBindings(instance);
    const metadata = await this.#valueMetadata(instance.url);
    this.#session.assertStopped(instance.frame!.event);
    return this.#valueRef(vars[`global${index}`]?.value, metadata.globals[index]);
  }

  #globalClone(id: number): Ref {
    const gid = this.#allocateHandle();
    this.#globals.set(gid, this.#globals.get(id)!);
    return { $res: "Global", id: gid };
  }

  async #instanceScopeBindings(
    instance: InstanceContext
  ): Promise<Record<string, { value?: unknown }>> {
    if (!instance.frame) throw unavailable("invalid-frame");
    const { actor, event } = instance.frame;
    this.#session.assertStopped(event);
    let env = (await this.#session.frameEnvironment(actor)) as
      | {
          scopeKind?: string;
          parent?: unknown;
          bindings?: { variables?: Record<string, { value?: unknown }> };
        }
      | undefined;
    this.#session.assertStopped(event);
    let depth = 0;
    while (env && env.scopeKind !== "wasm instance") {
      if (++depth > 64) throw unavailable("invalid-frame");
      env = env.parent as typeof env;
    }
    if (!env?.bindings?.variables) throw unavailable("invalid-frame");
    return env.bindings.variables;
  }

  async #valueMetadata(url: string): Promise<ModuleValues> {
    const { signal } = this.#generation;
    const cached = this.#metadataByUrl.get(url);
    if (cached) return cached;
    const bytes = await this.#wasmBytecode(url);
    if (!bytes) throw unavailable("unsupported-type");
    const metadata = await valueMetadata(bytes);
    signal.throwIfAborted();
    let entries =
      metadata.globals.length + metadata.functions.reduce((n, fn) => n + fn.locals.length, 0);
    for (const cached of this.#metadataByUrl.values())
      entries +=
        cached.globals.length + cached.functions.reduce((n, fn) => n + fn.locals.length, 0);
    if (entries > 2_000_000) throw new Error("value metadata cache exceeds 2000000 entries");
    this.#metadataByUrl.set(url, metadata);
    return metadata;
  }

  #valueRef(raw: unknown, type: ValueType | undefined): Ref {
    if (!type || type === "unsupported") throw unavailable("unsupported-type");
    if (raw && typeof raw === "object") {
      const grip = raw as { type?: string; text?: string };
      if (
        grip.type === "BigInt" &&
        typeof grip.text === "string" &&
        /^-?\d+$/.test(grip.text) &&
        grip.text.length <= 32
      )
        raw = BigInt(grip.text);
      else if (grip.type === "NaN") raw = NaN;
      else if (grip.type === "Infinity") raw = Infinity;
      else if (grip.type === "-Infinity") raw = -Infinity;
      else if (grip.type === "-0") raw = -0;
    }
    if (type === "i64" && typeof raw === "number") {
      if (!Number.isSafeInteger(raw)) {
        this.#logger.warn("[value] i64 unavailable: Firefox returned an unsafe JavaScript number");
        throw unavailable("unsupported-type");
      }
      raw = BigInt(raw);
    }
    if ((type === "i64" && typeof raw !== "bigint") || (type !== "i64" && typeof raw !== "number"))
      throw unavailable("invalid-frame");
    if (
      type === "i32" &&
      (!Number.isInteger(raw) || Number(raw) < -0x8000_0000 || Number(raw) > 0xffff_ffff)
    )
      throw unavailable("invalid-frame");
    const id = this.#allocateHandle();
    this.#valueById.set(id, { tag: `wasm-${type}`, raw: raw as number | bigint });
    return { $res: "WasmValue", id };
  }

  #wasmValueGetType(id: number): { tag: string } {
    return { tag: this.#valueById.get(id)!.tag };
  }

  #wasmValueUnwrapI32(id: number): number {
    const entry = this.#valueById.get(id);
    return Number(entry!.raw) >>> 0;
  }

  #wasmValueUnwrapI64(id: number): bigint {
    const entry = this.#valueById.get(id);
    return BigInt(entry!.raw);
  }

  #wasmValueUnwrapF(id: number): number {
    const entry = this.#valueById.get(id);
    return Number(entry!.raw);
  }

  #wasmValueClone(id: number): Ref {
    const v = this.#valueById.get(id);
    const newId = this.#allocateHandle();
    this.#valueById.set(newId, v!);
    return { $res: "WasmValue", id: newId };
  }

  #memoryContext(id: number) {
    const url = this.#memoryById.get(id);
    const event = this.#snapshotEvent;
    if (!url || !event) throw unavailable("invalid-frame");
    try {
      this.#session.assertStopped(event);
    } catch (cause) {
      throw unavailable("invalid-frame", cause);
    }
    const tids = [
      this.#session.stoppedTid,
      ...event.pausedTids.filter((tid) => tid !== this.#session.stoppedTid),
    ];
    for (const tid of tids) {
      const frame = this.#framesByTid
        .get(tid)
        ?.find(
          (f) =>
            f.type === "wasmcall" &&
            f.where &&
            this.#session.urlForSourceActor(f.where.actor) === url
        );
      const consoleActor = this.#session.consoleActorForThread(tid);
      if (frame && consoleActor)
        return { topActor: frame.actor, consoleActor, event, signal: this.#generation.signal };
    }
    throw unavailable("invalid-frame");
  }

  async #memorySize(id: number): Promise<number> {
    const { topActor, consoleActor, event, signal } = this.#memoryContext(id);
    try {
      const r = (await this.#session.evaluateInFrame(
        "memory0.buffer.byteLength",
        topActor,
        consoleActor
      )) as { result?: unknown };
      signal.throwIfAborted();
      this.#session.assertStopped(event);
      if (typeof r.result !== "number" || !Number.isSafeInteger(r.result) || r.result < 0)
        throw new Error("memory size evaluation returned a missing or invalid size");
      return r.result;
    } catch (cause) {
      this.#logger.error(`[memory] size failed stop=${event.stopId}: ${String(cause)}`);
      throw unavailable("invalid-frame", cause);
    }
  }

  async #readMemory(id: number, addr: number, len: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(addr) ||
      addr < 0 ||
      !Number.isSafeInteger(len) ||
      len < 0 ||
      len > MAX_MEMORY_READ
    )
      throw outOfBounds();
    const { signal, event, topActor, consoleActor } = this.#memoryContext(id);
    signal.throwIfAborted();
    this.#session.assertStopped(event);
    const expr =
      `(()=>{const b=memory0.buffer,a=${addr},n=${len};` +
      `if(a>b.byteLength||n>b.byteLength-a)return null;` +
      `let s='';for(const x of new Uint8Array(b,a,n))s+=x.toString(16).padStart(2,'0');return s;})()`;
    try {
      const response = (await this.#session.evaluateInFrame(expr, topActor, consoleActor)) as {
        result?: unknown;
      };
      signal.throwIfAborted();
      this.#session.assertStopped(event);
      if (
        response.result === null ||
        (typeof response.result === "object" &&
          (response.result as { type?: string })?.type === "null")
      )
        throw outOfBounds();
      if (
        typeof response.result !== "string" ||
        response.result.length !== len * 2 ||
        !/^[0-9a-f]*$/i.test(response.result)
      )
        throw new Error("memory evaluation returned missing or malformed bytes");
      return Uint8Array.from(Buffer.from(response.result, "hex"));
    } catch (cause) {
      if ((cause as { payload?: string })?.payload === "out-of-bounds") throw cause;
      this.#logger.error(
        `[memory] read failed stop=${event.stopId} address=${addr} length=${len}: ${String(cause)}`
      );
      throw Object.assign(new Error("invalid-frame", { cause }), { payload: "invalid-frame" });
    }
  }

  // --- resumption ----------------------------------------------------------
  #doContinue(): Ref {
    this.#armStopped();
    if (this.#stop.operation?.pending) {
      if (this.#stop.hostInterruptPending) {
        // Ctrl-C won the race with WIT dispatch. Establish a genuine RDP
        // all-stop now and let the real worker pause resolve EventFuture.
        this.#interruptForHost();
      } else if (this.#session.hasUnwitnessedPause()) {
        // Report an unwitnessed pause before resuming, including breakpoints that
        // fired during navigation before this execution wait was armed.
        void this.#session.adoptPausedState().catch((err) => {
          this.#logger.error(
            `[rdp] could not adopt paused state: ${err instanceof Error ? err.message : String(err)}`
          );
          this.#session.close();
        });
      } else {
        this.#session.resumeAll().catch((err) => {
          this.#logger.error(
            `[rdp] resume failed: ${err instanceof Error ? err.message : String(err)}`
          );
          this.#session.close();
        });
        const cb = this.#onFirstContinue;
        this.#onFirstContinue = null;
        cb?.();
      }
    }
    return this.#eventFutureRef();
  }

  #doSingleStep(tid: number): Ref {
    this.#armStopped();
    if (this.#stop.operation?.pending) {
      if (this.#stop.hostInterruptPending) {
        this.#interruptForHost();
        return this.#eventFutureRef();
      }
      // LLDB can step off a cached breakpoint before continuing. Report an
      // unwitnessed pause first so that step cannot skip the replacement's stop.
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
      const limit = innermost?.type === "call" ? "next" : "step";
      this.#session.stepOne(tid, limit);
    }
    return this.#eventFutureRef();
  }

  #doInterrupt(): null {
    this.#armStopped();
    if (this.#stop.operation?.pending) {
      this.#session.interrupt(this.#session.stoppedTid);
    }
    return null;
  }

  async #finishEvent(id: number): Promise<{ tag: string }> {
    const event = await this.#futureById.get(id)!.promise;
    await this.#snapshotStopped(event);
    return { tag: this.#eventTag() };
  }

  /** Collect a genuine stop and snapshot before the component's initial scan.
   * A missing pause or retired generation rejects attach. */
  async primeStop(timeoutMs = PRIME_STOP_TIMEOUT_MS): Promise<void> {
    // Select a live target; a remembered stopped thread may have been retired.
    const tid = this.#session.listTids()[0];
    if (tid === undefined) return;
    this.#armStopped();
    if (this.#session.paused()) {
      // A thread paused before we armed a listener (pauseOnExceptions fires
      // during page load). Interrupting it would draw an alreadyPaused error
      // reply instead of a paused event, which armAllStop cannot see, so adopt
      // the known paused state directly. Same guard as #doContinue/#doSingleStep.
      await this.#session.adoptPausedState();
    } else {
      this.#session.interrupt(tid);
    }
    // An unanswered interrupt fails attach instead of manufacturing an empty stop.
    if (!(await this.#awaitStop(timeoutMs))) {
      const error = new Error(`no complete stop within ${timeoutMs}ms of priming`);
      this.#stop.operation?.cancel(error);
      throw error;
    }
    await this.#snapshotStopped(await this.#stop.operation!.promise);
    await this.#preloadJsSources();
  }

  /** Await the armed stop, resolving false if it does not arrive in time. The
   * stop stays armed either way: a late pause is still reported normally. */
  async #awaitStop(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.#stop.operation!.promise.then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Request a genuine Firefox all-stop when the user presses Ctrl-C. */
  triggerInterrupt(): void {
    // A real interrupt supersedes any in-flight resync check: cancel it so
    // it can't later fire into an unrelated wait this triggerInterrupt() (or
    // whatever comes after it) arms. #clearResync() is a no-op if
    // nothing is armed.
    this.#clearResync();
    this.#stop.hostInterruptPending = true;
    this.#stop.forcingResync = false;
    if (this.#stop.operation?.pending) this.#interruptForHost();
  }

  #armStopped(): void {
    this.#stop.operation = this.#session.armAllStop();
    // Target/source arrival may precede LLDB's next command by arbitrarily
    // long. Keep the resync intent when its grace timer finds no active wait.
    if (this.#resyncTid !== undefined && !this.#resyncTimer) {
      this.#scheduleResyncCheck(this.#resyncTid);
    }
  }

  #interruptForHost(): void {
    const tid = this.#session.preferredInterruptTid();
    if (tid !== undefined) this.#session.interrupt(tid);
  }

  #clearResync(): void {
    this.#resyncTid = undefined;
    if (this.#resyncTimer) {
      clearTimeout(this.#resyncTimer);
      this.#resyncTimer = null;
    }
  }

  /** While execution is pending, allow a replacement's breakpoint to fire
   * before forcing a re-sync stop. Do not interrupt an idle replacement just
   * because LLDB retains an old stop; Firefox may have no frame to step. */
  #scheduleResyncCheck(tid: number): void {
    this.#clearResync();
    this.#resyncTid = tid;
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      if (!this.#stop.operation?.pending) {
        this.#logger.debug(
          `[debuggee] resync-deferred generation=${this.#session.topLevelGeneration()} tid=${tid}`
        );
        return;
      }
      const live = this.#session.listTids();
      if (live.length === 0) return; // nothing left to interrupt — a genuine close, not a swap
      if (this.#session.hasUnwitnessedPause()) {
        // Adopt its real pause packet; an existing collector remains the sole owner.
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

  // Retire the adapter's generation-owned handles and symbols. New module IDs
  // make LLDB observe a reload even when the URL is unchanged.
  #onNavigated(): void {
    this.#clearResync();
    this.#generation.abort(new Error("debuggee generation retired by navigation"));
    this.#generation = new AbortController();
    this.#bytecodeByUrl.clear();
    this.#syntheticByUrl.clear();
    this.#moduleByUrl.clear();
    this.#moduleById.clear();
    this.#framesByTid.clear();
    this.#frameInfoById.clear();
    this.#envCacheByActor.clear();
    this.#instances.clear();
    this.#globals.clear();
    this.#memoryById.clear();
    this.#metadataByUrl.clear();
    this.#memoryModuleUrl = undefined;
    this.#valueById.clear();
    this.#snapshotEvent = undefined;
    this.#unavailableFrames.clear();
    this.logState("generation-retired");
  }

  #eventFutureRef(): Ref {
    const id = this.#allocateHandle();
    if (!this.#stop.operation) throw new Error("no execution operation for future");
    this.#futureById.set(id, this.#stop.operation);
    return { $res: "EventFuture", id };
  }

  #eventTag(): string {
    switch (this.#stop.reason) {
      case "exception":
        return "trap";
      case "interrupted":
        return "interrupted";
      default:
        // "signal" (triggerInterrupt's Ctrl-C) deliberately has no case of
        // its own here and falls through to "breakpoint". The component's
        // Event::Interrupted
        // arm only reports a real stop when its own Rust-side self.interrupt
        // flag is set — i.e. LLDB called the native Debuggee.interrupt WIT
        // method over RSP. A host-manufactured Ctrl-C never sets that, so
        // tagging it "interrupted" would make the component treat it as
        // spurious and silently resume instead of actually stopping.
        return "breakpoint";
    }
  }
}
