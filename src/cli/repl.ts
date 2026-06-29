/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Node-side interactive REPL for the embedded wasm LLDB. Owns the terminal so
// we can offer line history (arrow keys), Ctrl-C interrupt of a running target,
// async notices printed above the prompt, and `js` subcommands that query the
// page over RDP. Lines are driven command-by-command through the off-worker
// session API (LLDBClient.sessionCommand), not the wasm interpreter's own REPL.

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { LLDBClient } from "lldb-wasm";
import { grip, type FrameForm, type RdpWasmSession } from "../rdp/session.js";

export interface ReplDeps {
  client: LLDBClient;
  /** The live RDP session for the attached tab, or undefined if not attached. */
  getSession: () => RdpWasmSession | undefined;
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

const PROMPT = "(lldb) ";
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
        void deps.client.pause().catch(() => {});
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
    if (cmd === "js" || cmd.startsWith("js ")) return dispatchJs(cmd.slice(2).trim());
    if ((cmd.match(/`/g) ?? []).length % 2 !== 0) {
      write("error: unbalanced backtick in command");
      return;
    }
    // Guard: very large memory reads overflow the lldb-wasm JSON IPC (64 KiB).
    // LLDB chunks reads into PacketSize=1000 byte requests, all of which succeed
    // individually, but the combined hex dump in one lldb-wasm message exceeds 64 KiB.
    // Cap at 8 KiB (produces ~32 KiB of hex output, safely under the ceiling).
    // Handles both: `memory read -c N` and `x/N`.
    const memReadCount =
      cmd.match(/^\s*(?:memory\s+read)\b.*?-c\s+(\d+)/i)?.[1] ??
      cmd.match(/^\s*x\/(\d+)/i)?.[1];
    if (memReadCount !== undefined && Number(memReadCount) > 8192) {
      write(`error: read count ${memReadCount} exceeds the 8192-byte limit (lldb-wasm JSON IPC constraint)`);
      return;
    }

    const isContinue = cmd === "c" || cmd === "continue" || cmd === "process continue";
    inflight = true;
    try {
      if (isContinue) {
        write("Process running.");
        deps.onTargetResume?.();
      }
      const res = await deps.client.sessionCommand(cmd);
      if (res.output) write(res.output);
      if (res.error) write(res.error);
    } catch (e) {
      write(`error: ${(e as Error).message}`);
    } finally {
      inflight = false;
    }
  }

  async function dispatchJs(rest: string): Promise<void> {
    const session = deps.getSession();
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

function formatFrame(index: number, frame: FrameForm): string {
  const name = (frame as { displayName?: string }).displayName || frame.type;
  const where = frame.where ? ` at ${frame.where.line}:${frame.where.column}` : "";
  return `  #${index}: ${name}${where}`;
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
