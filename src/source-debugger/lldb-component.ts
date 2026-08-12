/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LLDBClient, StopReason } from "lldb-wasm";
import type {
  CommandResult,
  ComponentFrame,
  ComponentId,
  ComponentRunRequest,
  ComponentStop,
  ModuleDescriptor,
  RunId,
  SessionState,
  SessionStopReason,
  SessionThread,
  SourceBreakpoint,
  SourceBreakpointRequest,
  SourceDebuggerComponentDescriptor,
  SourceFile,
  SourceScope,
  SourceValue,
  StopId,
  ThreadId,
} from "./types.js";
import type {
  ModuleClaim,
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
  SourceDebuggerComponentInstance,
} from "./component.js";
import { noopLogger, type Logger } from "../logging.js";

const LLDB_FAILED_STATUS = 6;

export interface LldbSourceDebuggerComponentOptions {
  id?: ComponentId;
  name?: string;
  onDispose?: () => void | Promise<void>;
  runControl?: LldbComponentRunControl;
  exclusiveModules?: boolean;
  abortBreakpointFunction?: string;
  logger?: Logger;
}

export interface LldbComponentRunControl {
  beginRun(request: ComponentRunRequest): Promise<void>;
  endRun(runId: RunId): void;
  waitForPhysicalResume(runId: RunId, afterSequence: number): Promise<number | undefined>;
  releasePhysicalResume(runId: RunId, sequence: number): void;
  synchronizeRun(runId: RunId): void;
  abortRun(runId: RunId): void;
}

function reasonFromLldb(reason: StopReason): SessionStopReason {
  const threadId = reason.thread_id === undefined ? undefined : String(reason.thread_id);
  switch (reason.reason) {
    case "breakpoint":
      return {
        kind: "breakpoint",
        ...(threadId ? { threadId } : {}),
        ...(reason.bp_id === undefined ? {} : { breakpointId: String(reason.bp_id) }),
      };
    case "step_complete":
      return { kind: "step", ...(threadId ? { threadId } : {}) };
    case "signal":
      return {
        kind:
          reason.signal_name === "SIGINT" || reason.signal_name === "SIGSTOP"
            ? "interrupt"
            : "signal",
        ...(threadId ? { threadId } : {}),
        ...(reason.signal_name ? { signal: reason.signal_name } : {}),
      } as SessionStopReason;
    case "exception":
      return { kind: "exception", ...(threadId ? { threadId } : {}) };
    case "stopped":
      return { kind: "stopped", ...(threadId ? { threadId } : {}) };
    case "running":
      return { kind: "running" };
    case "exited":
      return {
        kind: "exited",
        ...(reason.exit_code === undefined ? {} : { exitCode: reason.exit_code }),
      };
    case "none":
      return { kind: "none" };
  }
}

function escapeLldbArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function breakpointId(result: CommandResult): string | undefined {
  return result.output.match(/\bBreakpoint\s+(\d+):/)?.[1];
}

export class LldbSourceDebuggerComponent implements SourceDebuggerComponent {
  readonly #client: LLDBClient;
  readonly #options: LldbSourceDebuggerComponentOptions;

  constructor(client: LLDBClient, options: LldbSourceDebuggerComponentOptions = {}) {
    this.#client = client;
    this.#options = options;
  }

  async describe(): Promise<SourceDebuggerComponentDescriptor> {
    return descriptor(this.#options);
  }

  async probeModule(_module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return { supported: true, confidence: 50, reason: "LLDB fallback for Wasm modules" };
  }

  async instantiate(_host: SourceDebuggerComponentHost): Promise<SourceDebuggerComponentInstance> {
    return new LldbSourceDebuggerComponentInstance(this.#client, this.#options);
  }
}

export class LldbSourceDebuggerComponentInstance implements SourceDebuggerComponentInstance {
  readonly id: ComponentId;
  readonly #client: LLDBClient;
  readonly #name: string;
  readonly #runs = new Map<RunId, Promise<ComponentStop>>();
  readonly #breakpoints = new Map<string, SourceBreakpoint>();
  readonly #onDispose: (() => void | Promise<void>) | undefined;
  readonly #runControl: LldbComponentRunControl | undefined;
  readonly #exclusiveModules: boolean;
  readonly #abortBreakpointFunction: string | undefined;
  readonly #moduleIds = new Set<string>();
  readonly #logger: Logger;
  #abortBreakpointSetup: Promise<void> | undefined;

  constructor(client: LLDBClient, options: LldbSourceDebuggerComponentOptions = {}) {
    this.#client = client;
    this.id = options.id ?? "lldb";
    this.#name = options.name ?? "LLDB";
    this.#onDispose = options.onDispose;
    this.#runControl = options.runControl;
    this.#exclusiveModules = options.exclusiveModules ?? false;
    this.#abortBreakpointFunction = options.abortBreakpointFunction;
    this.#logger = options.logger ?? noopLogger;
  }

  async describe(): Promise<SourceDebuggerComponentDescriptor> {
    return descriptor({ id: this.id, name: this.#name });
  }

  async addModules(modules: ModuleDescriptor[], _initialStop: StopId): Promise<void> {
    for (const module of modules) {
      if (module.owner !== this.id) throw new Error(`component ${this.id} cannot own ${module.id}`);
      this.#moduleIds.add(module.id);
    }
  }

  async removeModules(moduleIds: string[]): Promise<void> {
    for (const id of moduleIds) this.#moduleIds.delete(id);
  }

  async sources(_moduleId?: string): Promise<SourceFile[]> {
    // LLDB discovers compile units lazily. Source enumeration will move to a
    // richer SB API adapter; the session currently obtains module URLs from RDP.
    return [];
  }

  async state(stopId: StopId): Promise<SessionState> {
    return { stopId, reason: reasonFromLldb(await this.#client.sessionState()) };
  }

  async threads(stopId: StopId): Promise<SessionThread[]> {
    const [count, state] = await Promise.all([this.#client.getNumThreads(), this.state(stopId)]);
    const stoppedId = "threadId" in state.reason ? state.reason.threadId : undefined;
    return Array.from({ length: count }, (_, index) => {
      // The selected/stopped RSP tid is authoritative. Other thread ids are
      // provisional until the SB adapter exposes structured thread metadata.
      const id = index === 0 && stoppedId ? stoppedId : String(index + 1);
      return { id, stopped: id === stoppedId };
    });
  }

  async frames(_stopId: StopId, _threadId: ThreadId): Promise<ComponentFrame[]> {
    const frames = await this.#client.sessionFrames();
    return frames
      .filter(
        (frame) =>
          !(frame.function === "??" && /^0x0+$/.test(frame.pc) && frame.file === undefined) &&
          !frame.file?.endsWith("__source_debugger_foreign__.wasm") &&
          !frame.file?.endsWith("__source_debugger_abort__.wasm") &&
          (!this.#exclusiveModules || wasmModuleIndex(frame.pc) < this.#moduleIds.size)
      )
      .map((frame) => ({
        id: String(frame.index),
        physicalFrameIndex: frame.index,
        inlineFrameIndex: 0,
        functionName: frame.function,
        ...(frame.file && frame.line
          ? {
              location: {
                sourceId: frame.file,
                line: frame.line,
              },
            }
          : {}),
        pc: frame.pc,
        inline: false,
      }));
  }

  async scopes(_stopId: StopId, frameId: string): Promise<SourceScope[]> {
    const index = parseFrameIndex(frameId);
    // The current bulk SBValue wrapper runs on the wasm worker thread while
    // run-control commands run on the session pthread. Besides failing to
    // materialize DW_OP_WASM_location in non-top frames, calling it can leave
    // LLDB unable to acknowledge the next resume. Keep all component
    // inspection on the session thread through the public command API.
    const materialized = await this.#commandFrameVariables(index);
    return [sourceScope([...materialized])];
  }

  async evaluate(
    _stopId: StopId,
    frameId: string,
    expression: string
  ): Promise<SourceValue | null> {
    const index = parseFrameIndex(frameId);
    // The public SB expression wrapper cannot yet materialize wasm local
    // expressions and leaves the expression context unusable for a retry.
    // Preserve debugger parity through the working session interpreter until
    // lldb-wasm exposes that evaluator as structured data.
    const selected = await this.command(`frame select ${index}`);
    if (selected.status >= LLDB_FAILED_STATUS) throw new Error(selected.error || "invalid frame");
    const result = await this.command(`expression -- ${expression}`);
    if (result.status >= LLDB_FAILED_STATUS) {
      throw new Error(result.error || "evaluation failed");
    }
    const parsed = parseExpressionResult(result.output);
    return parsed ?? { display: result.output.trim(), hasChildren: false };
  }

  async setBreakpoint(request: SourceBreakpointRequest): Promise<SourceBreakpoint> {
    let command: string;
    if (request.target.kind === "function") {
      command = `breakpoint set -n ${escapeLldbArgument(request.target.name)}`;
    } else {
      const location = request.target.location;
      command = `breakpoint set -f ${escapeLldbArgument(location.sourceId)} -l ${location.line}`;
    }
    if (request.condition) command += ` -c ${escapeLldbArgument(request.condition)}`;
    const result = await this.command(command);
    const id = breakpointId(result) ?? `unresolved-${this.#breakpoints.size + 1}`;
    const breakpoint: SourceBreakpoint = {
      id,
      componentId: this.id,
      verified: result.status < LLDB_FAILED_STATUS && !/no locations/i.test(result.output),
      target: request.target,
      ...((result.error || !breakpointId(result)) && {
        message: (result.error || result.output).trim(),
      }),
    };
    this.#breakpoints.set(id, breakpoint);
    return breakpoint;
  }

  async removeBreakpoint(id: string): Promise<void> {
    const result = await this.command(`breakpoint delete ${id}`);
    if (result.status >= LLDB_FAILED_STATUS)
      throw new Error(result.error || `could not delete ${id}`);
    this.#breakpoints.delete(id);
  }

  async breakpoints(): Promise<SourceBreakpoint[]> {
    return [...this.#breakpoints.values()];
  }

  async startRun(request: ComponentRunRequest): Promise<void> {
    if (this.#runs.has(request.runId)) throw new Error(`run ${request.runId} already exists`);
    await this.#ensureAbortBreakpoint();
    let temporaryBreakpointId: string | undefined;
    if (request.action.kind !== "continue" && request.action.frameId !== undefined) {
      const selected = await this.command(
        `frame select ${parseFrameIndex(request.action.frameId)}`
      );
      if (selected.status >= LLDB_FAILED_STATUS) {
        throw new Error(selected.error || `could not select frame ${request.action.frameId}`);
      }
    }
    if (request.action.kind === "prepare-frame") {
      const frameIndex = parseFrameIndex(request.action.frameId);
      const frame = (await this.#client.sessionFrames()).find(({ index }) => index === frameIndex);
      if (!frame || frame.function === "??") {
        throw new Error(`could not resolve entry frame ${request.action.frameId}`);
      }
      const breakpoint = await this.command(
        `breakpoint set -n ${escapeLldbArgument(frame.function)} -o true`
      );
      temporaryBreakpointId = breakpointId(breakpoint);
      if (breakpoint.status >= LLDB_FAILED_STATUS || !temporaryBreakpointId) {
        throw new Error(breakpoint.error || `could not prepare entry for ${frame.function}`);
      }
    }
    const ready = this.#runControl?.beginRun(request) ?? Promise.resolve();
    const command = commandForRun(request);
    const operation = this.command(command)
      .then(async (result) => {
        if (result.status >= LLDB_FAILED_STATUS)
          throw new Error(result.error || `${command} failed`);
        const reason = reasonFromLldb(await this.#client.sessionState());
        const disposition =
          request.role === "driver"
            ? ("accepted" as const)
            : isPreemptingObserverReason(reason)
              ? ("preempted" as const)
              : ("synchronized" as const);
        this.#logger.debug(
          `[${this.id}] ${request.runId} ${request.role} stopped as ${reason.kind} (${disposition})`
        );
        return {
          runId: request.runId,
          disposition,
          reason,
          output: (result.output + result.error).trimEnd(),
        };
      })
      .finally(async () => {
        this.#runControl?.endRun(request.runId);
        if (temporaryBreakpointId) {
          await this.command(`breakpoint delete ${temporaryBreakpointId}`).catch(() => {});
        }
      });
    this.#runs.set(request.runId, operation);
    // startRun is the session's arm barrier. Do not return until the LLDB
    // command has reached its debuggee resume call (or failed before it).
    await Promise.race([ready, operation.then(() => undefined)]);
  }

  async waitForStop(runId: RunId): Promise<ComponentStop> {
    const operation = this.#runs.get(runId);
    if (!operation) throw new Error(`unknown run ${runId}`);
    try {
      return await operation;
    } finally {
      this.#runs.delete(runId);
    }
  }

  waitForPhysicalResume(runId: RunId, afterSequence: number): Promise<number | undefined> {
    return (
      this.#runControl?.waitForPhysicalResume(runId, afterSequence) ?? Promise.resolve(undefined)
    );
  }

  async releasePhysicalResume(runId: RunId, sequence: number): Promise<void> {
    this.#runControl?.releasePhysicalResume(runId, sequence);
  }

  async cancelRun(runId: RunId): Promise<void> {
    if (!this.#runs.has(runId)) return;
    this.#logger.debug(`[${this.id}] cancelling ${runId}`);
    await this.#client.pause();
    this.#logger.debug(`[${this.id}] cancellation delivered for ${runId}`);
  }

  async synchronizeRun(runId: RunId): Promise<void> {
    this.#runControl?.synchronizeRun(runId);
  }

  async abortRun(runId: RunId): Promise<void> {
    this.#runControl?.abortRun(runId);
  }

  command(command: string): Promise<CommandResult> {
    return this.#client.sessionCommand(command);
  }

  async #commandFrameVariables(
    index: number
  ): Promise<Map<string, { type: string; display: string }>> {
    const selected = await this.command(`frame select ${index}`);
    if (selected.status >= LLDB_FAILED_STATUS) return new Map();
    const result = await this.command("frame variable");
    return result.status < LLDB_FAILED_STATUS || result.output
      ? parseFrameVariables(result.output)
      : new Map();
  }

  #ensureAbortBreakpoint(): Promise<void> {
    const functionName = this.#abortBreakpointFunction;
    if (!functionName) return Promise.resolve();
    return (this.#abortBreakpointSetup ??= (async () => {
      const result = await this.command(`breakpoint set -n ${escapeLldbArgument(functionName)}`);
      if (
        result.status >= LLDB_FAILED_STATUS ||
        !breakpointId(result) ||
        /no locations/i.test(result.output)
      ) {
        throw new Error(result.error || `could not install source debugger abort breakpoint`);
      }
    })());
  }

  async dispose(): Promise<void> {
    this.#runs.clear();
    this.#breakpoints.clear();
    this.#moduleIds.clear();
    await this.#onDispose?.();
  }
}

function descriptor(
  options: LldbSourceDebuggerComponentOptions = {}
): SourceDebuggerComponentDescriptor {
  return {
    protocolVersion: "0.1",
    id: options.id ?? "lldb",
    name: options.name ?? "LLDB",
    capabilities: {
      breakpoints: true,
      conditionalBreakpoints: true,
      evaluate: true,
      stepInto: true,
      stepOver: true,
      stepOut: true,
    },
  };
}

function parseFrameIndex(frameId: string): number {
  const index = Number(frameId);
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid LLDB frame ${frameId}`);
  return index;
}

function wasmModuleIndex(pc: string): number {
  try {
    return Number((BigInt(pc) >> 32n) & 0x0fffffffn);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function parseExpressionResult(output: string): SourceValue | null {
  const match = output.match(/^\s*\((.+)\)\s+\$\d+\s*=\s*(.*)$/m);
  if (!match) return null;
  return {
    type: match[1],
    display: match[2],
    hasChildren: /^(?:\{|\[)/.test(match[2]),
  };
}

function parseFrameVariables(output: string): Map<string, { type: string; display: string }> {
  const values = new Map<string, { type: string; display: string }>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\((.+)\)\s+([^\s=]+)\s*=\s*(.*)$/);
    if (match) values.set(match[2], { type: match[1], display: match[3] });
  }
  return values;
}

function sourceScope(values: Array<[string, { type: string; display: string }]>): SourceScope {
  return {
    name: "Locals",
    kind: "locals",
    values: values.map(([name, { type, display }]) => ({
      name,
      value: {
        name,
        type,
        display,
        hasChildren: /^(?:\{|\[)/.test(display),
      },
    })),
  };
}

function commandForRun(request: ComponentRunRequest): string {
  switch (request.action.kind) {
    case "continue":
      return "process continue";
    case "step-into":
      return "thread step-in";
    case "step-over":
      return "thread step-over";
    case "step-out":
      return "thread step-out";
    case "prepare-frame":
      return "process continue";
  }
}

function isPreemptingObserverReason(reason: SessionStopReason): boolean {
  switch (reason.kind) {
    case "breakpoint":
    case "exception":
    case "interrupt":
    case "exited":
      return true;
    case "signal":
      return reason.signal !== "SIGTRAP" && reason.signal !== "SIGSTOP";
    default:
      return false;
  }
}
