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

const LLDB_FAILED_STATUS = 6;

export interface LldbSourceDebuggerComponentOptions {
  id?: ComponentId;
  name?: string;
  onDispose?: () => void | Promise<void>;
  runControl?: LldbComponentRunControl;
  exclusiveModules?: boolean;
}

export interface LldbComponentRunControl {
  beginRun(request: ComponentRunRequest): Promise<void>;
  endRun(runId: RunId): void;
  synchronizeRun(runId: RunId): void;
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
  readonly #moduleIds = new Set<string>();

  constructor(client: LLDBClient, options: LldbSourceDebuggerComponentOptions = {}) {
    this.#client = client;
    this.id = options.id ?? "lldb";
    this.#name = options.name ?? "LLDB";
    this.#onDispose = options.onDispose;
    this.#runControl = options.runControl;
    this.#exclusiveModules = options.exclusiveModules ?? false;
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
    if (index > 0) {
      // Calling the current bulk SBValue wrapper first can poison evaluation of
      // DW_OP_WASM_location in a non-top frame. Select/materialize through the
      // interpreter before touching that wrapper.
      const fallback = await this.#commandFrameVariables(index);
      if (fallback.size) return [sourceScope([...fallback])];
    }

    const variables = await this.#client.getVariables(index);
    let fallback = new Map<string, { type: string; display: string }>();
    if (variables.some(({ value }) => value === "")) {
      // The current SB wrapper can enumerate non-top wasm variables while
      // returning empty value text. LLDB's command interpreter selects and
      // materializes the same frame correctly. Keep this narrow compatibility
      // adapter until lldb-wasm exposes the fixed structured SBValue path.
      fallback = await this.#commandFrameVariables(index);
    }
    return [
      {
        name: "Locals",
        kind: "locals",
        values: variables.map((variable) => {
          const materialized = fallback.get(variable.name);
          const display = materialized?.display ?? variable.value;
          return {
            name: variable.name,
            value: {
              name: variable.name,
              type: materialized?.type ?? variable.type,
              display,
              hasChildren: /^(?:\{|\[)/.test(display),
            },
          };
        }),
      },
    ];
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
    const ready = this.#runControl?.beginRun(request) ?? Promise.resolve();
    const command = commandForRun(request);
    const operation = this.command(command)
      .then(async (result) => {
        if (result.status >= LLDB_FAILED_STATUS)
          throw new Error(result.error || `${command} failed`);
        return {
          runId: request.runId,
          disposition:
            request.role === "driver" ? ("accepted" as const) : ("synchronized" as const),
          reason: reasonFromLldb(await this.#client.sessionState()),
          output: (result.output + result.error).trimEnd(),
        };
      })
      .finally(() => this.#runControl?.endRun(request.runId));
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

  async cancelRun(runId: RunId): Promise<void> {
    if (!this.#runs.has(runId)) return;
    await this.#client.pause();
  }

  async synchronizeRun(runId: RunId): Promise<void> {
    this.#runControl?.synchronizeRun(runId);
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
  }
}
