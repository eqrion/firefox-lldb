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
const JS_USAGE = "js: usage: js p <expr> | js bt | js frame <n>";

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
      const cmd = queue.shift()!.trim();
      if (cmd === "") continue;
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
      void deps.client.pause().catch(() => {});
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
    if (cmd === "js" || cmd.startsWith("js ")) return dispatchJs(cmd.slice(2).trim());

    inflight = true;
    try {
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
        case "":
          write(JS_USAGE);
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
      write("js p: usage: js p <expr>");
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
    write(formatFrame(n, frame));
    const env = (await session.frameEnvironment(frame.actor)) as {
      bindings?: {
        arguments?: Record<string, { value?: unknown }>[];
        variables?: Record<string, { value?: unknown }>;
      };
    };
    for (const line of formatBindings(env.bindings)) write("    " + line);
  }

  // The first JS call frame's actor (so `js p` sees locals), or undefined to
  // evaluate in page scope.
  async function topJsFrameActor(session: RdpWasmSession): Promise<string | undefined> {
    if (!session.paused()) return undefined;
    const frames = await session.frames(session.stoppedTid).catch(() => [] as FrameForm[]);
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
