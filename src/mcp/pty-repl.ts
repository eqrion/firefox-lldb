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
  #consumed = 0;
  #waiters: Array<() => void> = [];
  exited: Promise<void>;

  private constructor(child: IPty) {
    this.#child = child;
    child.onData((d: string) => {
      this.#out += d;
      this.#waiters.splice(0).forEach((w) => w());
    });
    this.exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
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
    await repl.#waitForPrompt(1, opts.startupTimeoutMs ?? 90_000);
    return repl;
  }

  // Send a command line and return the output it produced, once a fresh prompt
  // returns. `continue` has no prompt until the next stop, so a timeout here is
  // expected for a running target rather than an error.
  async send(command: string, timeoutMs = 60_000): Promise<SendResult> {
    const target = promptCount(this.#out) + 1;
    const mark = this.#consumed;
    this.#child.write(command + "\r");
    const prompt = await this.#waitForPrompt(target, timeoutMs).then(
      () => true,
      () => false
    );
    this.#consumed = this.#out.length;
    return { output: this.#clean(this.#out.slice(mark), command), prompt };
  }

  // Ctrl-C the running target, then wait for the stop output + prompt.
  async interrupt(timeoutMs = 30_000): Promise<SendResult> {
    const target = promptCount(this.#out) + 1;
    const mark = this.#consumed;
    this.#child.write("\x03");
    const prompt = await this.#waitForPrompt(target, timeoutMs).then(
      () => true,
      () => false
    );
    this.#consumed = this.#out.length;
    return { output: this.#clean(this.#out.slice(mark), ""), prompt };
  }

  // Drain any async output (streamed console messages, tab hints) without
  // sending a command. Waits up to timeoutMs for at least one new chunk.
  async read(timeoutMs = 2000): Promise<string> {
    if (this.#consumed >= this.#out.length) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.#waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const slice = this.#out.slice(this.#consumed);
    this.#consumed = this.#out.length;
    return this.#clean(slice, "");
  }

  async shutdown(): Promise<void> {
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
      await this.exited;
    }
  }

  // Resolve once the buffer holds at least `target` `(lldb)` prompts. Counting
  // (rather than "ends with prompt") avoids resolving on the stale prompt that
  // is already present from the previous command before this one has echoed.
  #waitForPrompt(target: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = (): void => {
        if (promptCount(this.#out) >= target) return resolve();
        if (Date.now() >= deadline) return reject(new Error("prompt timeout"));
        this.#waiters.push(check);
        setTimeout(check, 200);
      };
      check();
    });
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
