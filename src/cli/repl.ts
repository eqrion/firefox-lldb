/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Language-generic SourceDebuggerSession REPL. Owns the terminal so we can
// offer line history, Ctrl-C interrupt, async console notices, and a temporary
// debugger-native command escape hatch while the generic API grows.

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { grip, type FrameForm, type RdpWasmSession } from "../rdp/session.js";
import { SourceDebuggerSession } from "../source-debugger/session.js";
import type { LogicalFrame, LogicalFrameId } from "../source-debugger/types.js";

export interface ReplDeps {
  session: SourceDebuggerSession;
  input?: Readable;
  output?: Writable;
  /** Called when the REPL exits (Ctrl-D, `quit`, or double Ctrl-C). */
  onExit?: () => void;
  /** Called when the user resumes the target (c/continue). */
  onTargetResume?: () => void;
  /** Called when the user Ctrl-C's a running target. Should interrupt Firefox directly. */
  onTargetInterrupt?: () => void;
}

export interface Repl {
  /** Print text above the prompt, redrawing the in-progress input line. */
  print: (text: string) => void;
  /** Like print, but suppressed while console output is muted (`console off`). */
  printConsole: (text: string) => void;
  /** Show the banner and start prompting for input. */
  start: (banner?: string) => void;
  close: () => void;
  /** Resolves when the REPL exits. */
  done: Promise<void>;
}

const PROMPT = "(sdb) ";
const GENERIC_HELP = `\
Source debugger commands:
  components                 list loaded SourceDebuggerComponents
  modules                    list Wasm modules and their owners
  threads                    list threads
  bt                         show the composed source backtrace
  frame <N>                  select and display a source frame
  locals                     show variables in the selected frame
  p <EXPR>                   evaluate in the selected frame
  break [COMPONENT::]<FILE>:<LINE>
                             set a source breakpoint
  break [COMPONENT::]<FUNCTION>
                             set a function breakpoint
  breakpoints                list breakpoints
  delete <ID>                remove a breakpoint
  continue | c [COMPONENT]   continue with an optional run-control driver
  step | s                   step into
  next | n                   step over
  finish                     step out
  lldb [COMPONENT::]<COMMAND>
                             run a debugger-native LLDB command`;
const JS_HELP =
  "js p <expr>    evaluate JS (expression is literal to end of line; e.g. js p document.title)\n" +
  "js bt          print the JS call stack\n" +
  "js frame <n>   show frame details and select it for js p (default: top call frame)";

export function runRepl(deps: ReplDeps): Repl {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const rl = readline.createInterface({ input, output, terminal: true, prompt: PROMPT });
  const editable = rl as unknown as { line: string; cursor: number };

  const queue: string[] = [];
  let draining = false;
  let ready = false;
  let busy = false; // a command (lldb or js) is being dispatched
  let inflight = false; // a sessionCommand is running (the target may be running)
  let consoleMuted = false;
  let closed = false;
  let lastSigintAt = 0;
  let lastCommand = "";
  let jsFrameIndex = 0;
  let jsFrameTid: number | undefined;
  let selectedFrameId: LogicalFrameId | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const write = (text: string): void => {
    output.write(text.endsWith("\n") ? text : text + "\n");
  };

  // Print an async notice. While a command is running, the prompt isn't shown,
  // so just append; at an idle prompt, clear the line, print, and redraw it.
  const print = (text: string): void => {
    if (closed) return;
    if (ready && !busy) {
      readline.cursorTo(output, 0);
      readline.clearLine(output, 0);
      write(text);
      rl.prompt(true);
    } else {
      write(text);
    }
  };

  const printConsole = (text: string): void => {
    if (!consoleMuted) print(text);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    rl.close();
    deps.onExit?.();
    resolveDone();
  };

  rl.on("line", (line) => {
    if (closed) return;
    queue.push(line);
    if (ready) void drain();
  });
  rl.on("close", () => close());
  rl.on("SIGINT", () => onInterrupt());

  // Lines are queued and drained serially so typed-ahead input (and piped
  // scripts) are processed in order rather than dropped while a command runs.
  // readline stays live throughout, so Ctrl-C still reaches a running target.
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length && !closed) {
      const raw = queue.shift()!.trim();
      const cmd = raw === "" ? lastCommand : raw;
      if (cmd === "") continue;
      if (raw !== "") lastCommand = raw;
      busy = true;
      try {
        await dispatch(cmd);
      } finally {
        busy = false;
      }
    }
    draining = false;
    if (!closed) rl.prompt();
  }

  function onInterrupt(): void {
    if (inflight) {
      // A target is running under `process continue`/`run`; interrupt it. The
      // pending sessionCommand resolves with the stop output.
      write("^C");
      if (deps.onTargetInterrupt) {
        deps.onTargetInterrupt();
      } else {
        void deps.session.cancelActiveRun().catch(() => {});
      }
      return;
    }
    const hadText = editable.line.length > 0;
    write("^C");
    editable.line = "";
    editable.cursor = 0;
    if (!hadText) {
      if (Date.now() - lastSigintAt < 1000) {
        close();
        return;
      }
      lastSigintAt = Date.now();
      write("(^C again to quit)");
    }
    rl.prompt();
  }

  async function dispatch(cmd: string): Promise<void> {
    if (cmd === "quit" || cmd === "q" || cmd === "exit") return close();
    if (cmd === "console off") {
      consoleMuted = true;
      write("console output muted");
      return;
    }
    if (cmd === "console on") {
      consoleMuted = false;
      write("console output unmuted");
      return;
    }
    if (cmd === "help js") {
      write(JS_HELP);
      return;
    }
    if (cmd === "help" || cmd === "help source") {
      write(GENERIC_HELP);
      return;
    }
    if (cmd === "js" || cmd.startsWith("js ")) return dispatchJs(cmd.slice(2).trim());
    try {
      if (await dispatchSourceCommand(cmd)) return;
    } catch (e) {
      write(`error: ${(e as Error).message}`);
      return;
    }
    if ((cmd.match(/`/g) ?? []).length % 2 !== 0) {
      write("error: unbalanced backtick in command");
      return;
    }
    // Guard: commands that produce very large LLDB output overflow the lldb-wasm
    // JSON IPC (64 KiB message limit). The following are known to hit this:
    //   - `memory read -c N` / `x/N` with N > 8192
    //   - `image lookup -r` (regex lookup returns thousands of results for large modules)
    const memReadCount =
      cmd.match(/^\s*(?:memory\s+read)\b.*?-c\s+(\d+)/i)?.[1] ?? cmd.match(/^\s*x\/(\d+)/i)?.[1];
    if (memReadCount !== undefined && Number(memReadCount) > 8192) {
      write(
        `error: read count ${memReadCount} exceeds the 8192-byte limit (lldb-wasm JSON IPC constraint)`
      );
      return;
    }
    if (/^\s*image\s+lookup\s+.*-r\b/i.test(cmd)) {
      write(
        "error: regex image lookup (-r) can produce thousands of results and overflow the lldb-wasm IPC; use a specific name with -n instead"
      );
      return;
    }

    const isContinue = cmd === "c" || cmd === "continue" || cmd === "process continue";
    inflight = true;
    try {
      if (isContinue) {
        write("Process running.");
        deps.onTargetResume?.();
      }
      const res = await deps.session.command(cmd);
      if (res.output) write(res.output);
      if (res.error) write(res.error);
    } catch (e) {
      write(`error: ${(e as Error).message}`);
    } finally {
      inflight = false;
    }
  }

  async function dispatchSourceCommand(cmd: string): Promise<boolean> {
    const [verb = "", ...words] = cmd.split(/\s+/);
    const arg = cmd.slice(verb.length).trim();
    switch (verb) {
      case "components": {
        const components = await deps.session.componentStatuses();
        for (const component of components) {
          if (component.status === "ready") {
            write(
              `${component.id}\t${component.descriptor.name}\tprotocol ${component.descriptor.protocolVersion}`
            );
          } else {
            write(
              `${component.id}\t${component.descriptor?.name ?? "unavailable"}\tquarantined: ${component.message}`
            );
          }
        }
        return true;
      }
      case "modules": {
        const modules = await deps.session.modules();
        if (!modules.length) write("no Wasm modules");
        for (const module of modules) {
          write(
            `${module.id}\t[${module.owner}]\t${module.url}${module.debugInfo ? `\tdebug: ${module.debugInfo.join(", ") || "none"}` : ""}`
          );
        }
        return true;
      }
      case "threads": {
        const threads = await deps.session.threads();
        if (!threads.length) write("no threads");
        for (const thread of threads) {
          write(
            `${thread.stopped ? "*" : " "} ${thread.id}${thread.name ? ` ${thread.name}` : ""}`
          );
        }
        return true;
      }
      case "bt":
      case "backtrace": {
        const frames = await deps.session.frames();
        selectedFrameId = frames[0]?.id;
        if (!frames.length) write("no frames");
        frames.forEach((frame, index) => write(formatSourceFrame(index, frame)));
        return true;
      }
      case "frame":
      case "f": {
        const index = Number(words[0] ?? "0");
        const frames = await deps.session.frames();
        const frame = frames[index];
        if (!frame) throw new Error(`no frame ${words[0] ?? "0"}`);
        selectedFrameId = frame.id;
        write(formatSourceFrame(index, frame));
        return true;
      }
      case "locals": {
        const frameId = await selectedFrame();
        const scopes = await deps.session.scopes(frameId);
        for (const scope of scopes) {
          write(`${scope.name}:`);
          if (scope.values.length) {
            for (const property of scope.values) {
              const type = property.value.type ? `(${property.value.type}) ` : "";
              write(`  ${type}${property.name} = ${property.value.display}`);
            }
          } else if (scope.presentation) {
            for (const line of scope.presentation.split("\n")) write(`  ${line}`);
          } else {
            write("  <empty>");
          }
        }
        return true;
      }
      case "p": {
        if (!arg) throw new Error("p requires an expression");
        const value = await deps.session.evaluate(await selectedFrame(), arg);
        write(value ? `${value.type ? `(${value.type}) ` : ""}${value.display}` : "<unavailable>");
        return true;
      }
      case "break":
      case "b": {
        if (!arg) throw new Error("break requires FILE:LINE or FUNCTION");
        const qualified = componentQualifiedArgument(arg);
        if (!qualified.value) throw new Error("break requires FILE:LINE or FUNCTION");
        const source = qualified.value.match(/^(.*):(\d+)$/);
        const breakpoint = await deps.session.setBreakpoint({
          ...(qualified.componentId ? { componentId: qualified.componentId } : {}),
          target: source
            ? {
                kind: "source",
                location: { sourceId: source[1], line: Number(source[2]) },
              }
            : { kind: "function", name: qualified.value },
        });
        write(
          `Breakpoint ${breakpoint.id}: ${breakpoint.verified ? "verified" : "pending"}${breakpoint.message ? ` (${breakpoint.message})` : ""}`
        );
        return true;
      }
      case "breakpoints": {
        const breakpoints = await deps.session.breakpoints();
        if (!breakpoints.length) write("no breakpoints");
        for (const breakpoint of breakpoints) {
          const target =
            breakpoint.target.kind === "function"
              ? breakpoint.target.name
              : `${breakpoint.target.location.sourceId}:${breakpoint.target.location.line}`;
          write(`${breakpoint.id}\t${breakpoint.verified ? "verified" : "pending"}\t${target}`);
        }
        return true;
      }
      case "delete": {
        if (!arg) throw new Error("delete requires a breakpoint id");
        await deps.session.removeBreakpoint(arg);
        write(`Deleted breakpoint ${arg}`);
        return true;
      }
      case "continue":
      case "c":
        if (words.length > 1) throw new Error("continue accepts at most one component id");
        await runSourceCommand(() => deps.session.continue(words[0]));
        return true;
      case "step":
      case "s":
        await runSourceCommand((frameId) => deps.session.stepInto(frameId), true);
        return true;
      case "next":
      case "n":
        await runSourceCommand((frameId) => deps.session.stepOver(frameId), true);
        return true;
      case "finish":
        await runSourceCommand((frameId) => deps.session.stepOut(frameId), true);
        return true;
      case "lldb": {
        if (!arg) throw new Error("lldb requires a command");
        const qualified = componentQualifiedArgument(arg);
        if (!qualified.value) throw new Error("lldb requires a command");
        const result = await deps.session.command(qualified.value, qualified.componentId);
        if (result.output) write(result.output);
        if (result.error) write(result.error);
        return true;
      }
      default:
        return false;
    }
  }

  async function runSourceCommand(
    operation: (frameId: LogicalFrameId | undefined) => Promise<{ output?: string }>,
    frameRelative = false
  ): Promise<void> {
    inflight = true;
    try {
      const frameId = frameRelative ? await selectedFrame() : selectedFrameId;
      selectedFrameId = undefined;
      write("Process running.");
      deps.onTargetResume?.();
      const stop = await operation(frameId);
      if (stop.output) write(stop.output);
    } finally {
      inflight = false;
    }
  }

  async function selectedFrame(): Promise<LogicalFrameId> {
    if (selectedFrameId) return selectedFrameId;
    const frame = (await deps.session.frames())[0];
    if (!frame) throw new Error("no selected frame");
    selectedFrameId = frame.id;
    return frame.id;
  }

  async function dispatchJs(rest: string): Promise<void> {
    const session = deps.session.rdpSession();
    if (!session) {
      write("js: no attached tab");
      return;
    }
    const sub = rest.split(/\s+/)[0] ?? "";
    const arg = rest.slice(sub.length).trim();
    try {
      switch (sub) {
        case "p":
        case "eval":
        case "expr":
          return await jsEval(session, arg);
        case "bt":
        case "backtrace":
          return await jsBacktrace(session);
        case "frame":
        case "f":
          return await jsFrame(session, arg);
        case "help":
        case "":
          write(JS_HELP);
          return;
        default:
          write(`js: unknown subcommand '${sub}'`);
          return;
      }
    } catch (e) {
      write(`js: ${(e as Error).message}`);
    }
  }

  async function jsEval(session: RdpWasmSession, expr: string): Promise<void> {
    if (!expr) {
      write("js p: expression required — e.g. js p document.title");
      return;
    }
    const frameActor = await topJsFrameActor(session);
    const pkt = (await session.evalJS(
      expr,
      frameActor,
      session.stoppedConsoleActor ?? undefined
    )) as {
      result?: unknown;
      exceptionMessage?: string;
    };
    if (pkt.exceptionMessage) write(pkt.exceptionMessage);
    else write(grip(pkt.result));
  }

  async function jsBacktrace(session: RdpWasmSession): Promise<void> {
    if (!session.paused()) {
      write("js bt: not paused");
      return;
    }
    const frames = await session.frames(session.stoppedTid);
    if (!frames.length) {
      write("js bt: no frames");
      return;
    }
    frames.forEach((f, i) => write(formatFrame(i, f)));
  }

  async function jsFrame(session: RdpWasmSession, arg: string): Promise<void> {
    if (!session.paused()) {
      write("js frame: not paused");
      return;
    }
    const n = Number(arg || "0");
    const frames = await session.frames(session.stoppedTid);
    const frame = frames[n];
    if (!frame) {
      write(`js frame: no frame ${n}`);
      return;
    }
    jsFrameIndex = n;
    jsFrameTid = session.stoppedTid;
    write(formatFrame(n, frame));
    const env = (await session.frameEnvironment(frame.actor)) as {
      bindings?: {
        arguments?: Record<string, { value?: unknown }>[];
        variables?: Record<string, { value?: unknown }>;
      };
    };
    for (const line of formatBindings(env.bindings)) write("    " + line);
  }

  // The frame actor to use for `js p`: the user-selected frame if it is still
  // valid for this stop, otherwise the first JS call frame.
  async function topJsFrameActor(session: RdpWasmSession): Promise<string | undefined> {
    if (!session.paused()) return undefined;
    const frames = await session.frames(session.stoppedTid).catch(() => [] as FrameForm[]);
    if (jsFrameTid === session.stoppedTid && jsFrameIndex < frames.length) {
      return frames[jsFrameIndex]?.actor;
    }
    return frames.find((f) => f.type === "call")?.actor;
  }

  function start(banner?: string): void {
    ready = true;
    if (banner) write(banner);
    rl.prompt();
    if (queue.length) void drain();
  }

  return { print, printConsole, start, close, done };
}

function componentQualifiedArgument(argument: string): {
  componentId?: string;
  value: string;
} {
  const separator = argument.indexOf("::");
  if (separator < 0) return { value: argument };
  const componentId = argument.slice(0, separator).trim();
  if (!componentId) return { value: argument };
  return { componentId, value: argument.slice(separator + 2).trim() };
}

function formatFrame(index: number, frame: FrameForm): string {
  const name = (frame as { displayName?: string }).displayName || frame.type;
  const where = frame.where ? ` at ${frame.where.line}:${frame.where.column}` : "";
  return `  #${index}: ${name}${where}`;
}

function formatSourceFrame(index: number, frame: LogicalFrame): string {
  const where = frame.location
    ? ` at ${frame.location.sourceId}:${frame.location.line}${
        frame.location.column === undefined ? "" : `:${frame.location.column}`
      }`
    : frame.pc
      ? ` at ${frame.pc}`
      : "";
  return `#${index} ${frame.functionName}${where} [${frame.componentId}]`;
}

function formatBindings(bindings?: {
  arguments?: Record<string, { value?: unknown }>[];
  variables?: Record<string, { value?: unknown }>;
}): string[] {
  const out: string[] = [];
  for (const entry of bindings?.arguments ?? []) {
    const [name, desc] = Object.entries(entry)[0] ?? [];
    if (name) out.push(`${name} = ${grip(desc?.value)}`);
  }
  for (const [name, desc] of Object.entries(bindings?.variables ?? {})) {
    out.push(`${name} = ${grip(desc.value)}`);
  }
  return out;
}
