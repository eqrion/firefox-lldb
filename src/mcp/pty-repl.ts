/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Drives the *real* firefox-lldb CLI in a pseudo-terminal. Spawning the actual
// binary (rather than re-wiring runRepl in-process) means the harness exercises
// exactly what a human user runs: same readline, same `(lldb)` prompt, same
// Ctrl-C handling. node-pty gives a genuine TTY so `\x03` becomes a real SIGINT
// the REPL's `rl.on("SIGINT")` path handles.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const promptCount = (s: string): number => (stripAnsi(s).match(/\(lldb\)/g) ?? []).length;
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
export const DEFAULT_SEND_TIMEOUT_MS = 5_000;

interface PromptWaiter {
  target: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev we run the .ts CLI through tsx; a built dist runs the .js directly.
const IS_TS = __dirname.endsWith("src/mcp");
const CLI = join(__dirname, "..", "cli", IS_TS ? "firefox-lldb.ts" : "firefox-lldb.js");

export interface LaunchOptions {
  url: string;
  headless?: boolean;
  rdpPort: number;
  marionettePort: number;
  /** JS to evaluate in the page on the first continue (auto-trigger a workload
   * without a separate page driver). Maps to the CLI's --fire. */
  fire?: string;
  /** Time to wait for the first prompt after attach (ms). */
  startupTimeoutMs?: number;
}

export interface SendResult {
  output: string;
  /** True if a fresh `(lldb)` prompt returned; false if it timed out (the
   * target is likely still running — use interrupt() or read()). */
  prompt: boolean;
}

export class PtyRepl {
  #child: IPty;
  #out = "";
  #outBase = 0;
  #consumed = 0; // absolute offset, including bytes compacted from #out
  #promptTotal = 0;
  #promptTail = "";
  #waiters = new Set<PromptWaiter>();
  #sendQueue: Promise<void> = Promise.resolve();
  #shutdownPromise: Promise<void> | undefined;
  exited: Promise<void>;

  private constructor(child: IPty) {
    this.#child = child;
    child.onData((d: string) => {
      this.#append(d);
      for (const waiter of [...this.#waiters]) {
        if (this.#promptTotal >= waiter.target) this.#settleWaiter(waiter);
      }
    });
    this.exited = new Promise<void>((resolve) =>
      child.onExit(() => {
        for (const waiter of [...this.#waiters]) {
          this.#settleWaiter(waiter, new Error("firefox-lldb exited before returning a prompt"));
        }
        resolve();
      })
    );
  }

  // Launch Firefox + the CLI and resolve once the first `(lldb)` prompt is live.
  static async launch(opts: LaunchOptions): Promise<PtyRepl> {
    const args = [
      ...(IS_TS ? ["--import", "tsx"] : []),
      CLI,
      "--launch",
      ...(opts.headless ? ["--headless"] : []),
      "--rdp-port",
      String(opts.rdpPort),
      "--marionette-port",
      String(opts.marionettePort),
      ...(opts.fire ? ["--fire", opts.fire] : []),
      "--url",
      opts.url,
    ];
    const child: IPty = ptySpawn(process.execPath, args, {
      name: "xterm-color",
      cols: 120,
      rows: 40,
      env: process.env as Record<string, string>,
    });
    const repl = new PtyRepl(child);
    try {
      await repl.#waitForPrompt(1, opts.startupTimeoutMs ?? 90_000);
      return repl;
    } catch (err) {
      const output = await repl.read(0);
      await repl.shutdown();
      throw new Error(
        output
          ? `${err instanceof Error ? err.message : String(err)}: ${output}`
          : err instanceof Error
            ? err.message
            : String(err)
      );
    }
  }

  // Send a command line and return the output it produced, once a fresh prompt
  // returns. `continue` has no prompt until the next stop, so a timeout here is
  // expected for a running target rather than an error.
  async send(command: string, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<SendResult> {
    const run = this.#sendQueue.then(async () => {
      const target = this.#promptTotal + 1;
      const mark = this.#consumed;
      this.#child.write(command + "\r");
      const prompt = await this.#waitForPrompt(target, timeoutMs).then(
        () => true,
        () => false
      );
      const raw = this.#sliceFrom(mark);
      this.#consumed = this.#endOffset();
      return { output: this.#clean(raw, command), prompt };
    });
    this.#sendQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // Ctrl-C the running target, then wait for the stop output + prompt.
  async interrupt(timeoutMs = 30_000): Promise<SendResult> {
    const target = this.#promptTotal + 1;
    const mark = this.#consumed;
    this.#child.write("\x03");
    const prompt = await this.#waitForPrompt(target, timeoutMs).then(
      () => true,
      () => false
    );
    const raw = this.#sliceFrom(mark);
    this.#consumed = this.#endOffset();
    return { output: this.#clean(raw, ""), prompt };
  }

  // Drain any async output (streamed console messages, tab hints) without
  // sending a command. Waits up to timeoutMs for at least one new chunk.
  async read(timeoutMs = 2000): Promise<string> {
    if (this.#consumed >= this.#endOffset()) {
      await new Promise<void>((resolve) => {
        let done = false;
        let disposable: { dispose(): void } | undefined;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          disposable?.dispose();
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        disposable = this.#child.onData(finish);
      });
    }
    const slice = this.#sliceFrom(this.#consumed);
    this.#consumed = this.#endOffset();
    return this.#clean(slice, "");
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = this.#shutdown();
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    try {
      this.#child.write("quit\r");
    } catch {
      // pty may already be gone
    }
    const done = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!done) {
      try {
        this.#child.kill();
      } catch {
        // already dead
      }
      const killed = await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!killed) throw new Error("firefox-lldb PTY did not exit after kill");
    }
  }

  // Resolve once the buffer holds at least `target` `(lldb)` prompts. Counting
  // (rather than "ends with prompt") avoids resolving on the stale prompt that
  // is already present from the previous command before this one has echoed.
  #waitForPrompt(target: number, timeoutMs: number): Promise<void> {
    if (this.#promptTotal >= target) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let waiter!: PromptWaiter;
      const timer = setTimeout(
        () => this.#settleWaiter(waiter, new Error("prompt timeout")),
        timeoutMs
      );
      waiter = {
        target,
        resolve,
        reject,
        timer,
      };
      this.#waiters.add(waiter);
    });
  }

  #settleWaiter(waiter: PromptWaiter, err?: Error): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve();
  }

  #append(data: string): void {
    const combined = this.#promptTail + data;
    this.#promptTotal += promptCount(combined) - promptCount(this.#promptTail);
    this.#promptTail = combined.slice(-32);
    this.#out += data;
    if (this.#out.length > MAX_BUFFER_CHARS) {
      const drop = this.#out.length - MAX_BUFFER_CHARS;
      this.#out = this.#out.slice(drop);
      this.#outBase += drop;
      this.#consumed = Math.max(this.#consumed, this.#outBase);
    }
  }

  #endOffset(): number {
    return this.#outBase + this.#out.length;
  }

  #sliceFrom(offset: number): string {
    return this.#out.slice(Math.max(0, offset - this.#outBase));
  }

  // Strip ANSI, the leading echo of the typed command, and the trailing prompt
  // line so the agent sees just the command's output.
  #clean(raw: string, command: string): string {
    let s = stripAnsi(raw).replace(/\r/g, "");
    if (command) {
      const lines = s.split("\n");
      if (lines[0]?.trim() === command.trim()) lines.shift();
      s = lines.join("\n");
    }
    return s.replace(/\n*\(lldb\)\s*$/, "").trim();
  }
}
