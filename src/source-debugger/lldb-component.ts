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
  SourceProperty,
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

function parseValues(output: string): SourceProperty[] {
  const values: SourceProperty[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\((.+)\)\s+([^\s=]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values.push({
      name: match[2],
      value: {
        name: match[2],
        type: match[1],
        display: match[3],
        hasChildren: /^(?:\{|\[)/.test(match[3]),
      },
    });
  }
  return values;
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

  constructor(client: LLDBClient, options: LldbSourceDebuggerComponentOptions = {}) {
    this.#client = client;
    this.id = options.id ?? "lldb";
    this.#name = options.name ?? "LLDB";
  }

  async describe(): Promise<SourceDebuggerComponentDescriptor> {
    return descriptor({ id: this.id, name: this.#name });
  }

  async addModules(_modules: ModuleDescriptor[], _initialStop: StopId): Promise<void> {}

  async removeModules(_moduleIds: string[]): Promise<void> {}

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
    return frames.map((frame) => ({
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
    const selected = await this.command(`frame select ${index}`);
    if (selected.status >= LLDB_FAILED_STATUS) throw new Error(selected.error || "invalid frame");
    const result = await this.command("frame variable");
    if (result.status >= LLDB_FAILED_STATUS && !result.output) {
      throw new Error(result.error || "could not read variables");
    }
    return [
      {
        name: "Locals",
        kind: "locals",
        values: parseValues(result.output),
        presentation: result.output.trimEnd(),
      },
    ];
  }

  async evaluate(
    _stopId: StopId,
    frameId: string,
    expression: string
  ): Promise<SourceValue | null> {
    const index = parseFrameIndex(frameId);
    const selected = await this.command(`frame select ${index}`);
    if (selected.status >= LLDB_FAILED_STATUS) throw new Error(selected.error || "invalid frame");
    const result = await this.command(`expression -- ${expression}`);
    if (result.status >= LLDB_FAILED_STATUS) throw new Error(result.error || "evaluation failed");
    const value = parseValues(result.output)[0]?.value;
    return value ?? { display: result.output.trim(), hasChildren: false };
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
    const command = commandForRun(request);
    const operation = this.command(command).then(async (result) => {
      if (result.status >= LLDB_FAILED_STATUS) throw new Error(result.error || `${command} failed`);
      return {
        runId: request.runId,
        disposition: "accepted" as const,
        reason: reasonFromLldb(await this.#client.sessionState()),
        output: (result.output + result.error).trimEnd(),
      };
    });
    this.#runs.set(request.runId, operation);
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

  command(command: string): Promise<CommandResult> {
    return this.#client.sessionCommand(command);
  }

  async dispose(): Promise<void> {
    this.#runs.clear();
    this.#breakpoints.clear();
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
