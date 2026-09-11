/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Drives the real CLI in a PTY, including readline and terminal Ctrl-C.
// Private completion markers correlate commands without interpreting page text.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { randomBytes } from "node:crypto";
import { PTY_PROMPT_TOKEN_ENV, ptyPromptMarker } from "../config.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
export const DEFAULT_SEND_TIMEOUT_MS = 5_000;

class PromptTimeout extends Error {}

/** The CLI may still own resources; replacement must not start another lifetime. */
export class PtyCleanupError extends AggregateError {}

export function validateTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 120_000)
    throw new Error("timeoutMs must be an integer from 0 to 120000");
}

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
  signal?: AbortSignal;
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
  #consumed = 0; // Independent read cursor; commands never consume its output.
  #promptTotal = 0;
  #promptTail = "";
  #waiters = new Set<PromptWaiter>();
  #sendQueue: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #command?: { target: number; mark: number };
  #interruptPromise?: Promise<SendResult>;
  #hasExited = false;
  #readWaiters = new Set<() => void>();
  #shutdownPromise: Promise<void> | undefined;
  exited: Promise<void>;

  private constructor(
    child: IPty,
    private readonly marker: string
  ) {
    this.#child = child;
    child.onData((d: string) => {
      this.#append(d);
      if (this.#command && this.#promptTotal >= this.#command.target) this.#command = undefined;
      for (const waiter of [...this.#waiters]) {
        if (this.#promptTotal >= waiter.target) this.#settleWaiter(waiter);
      }
      for (const finish of [...this.#readWaiters]) finish();
    });
    this.exited = new Promise<void>((resolve) =>
      child.onExit(() => {
        this.#hasExited = true;
        for (const waiter of [...this.#waiters]) {
          this.#settleWaiter(waiter, new Error("firefox-lldb exited before returning a prompt"));
        }
        for (const finish of [...this.#readWaiters]) finish();
        resolve();
      })
    );
  }

  // Launch Firefox + the CLI and resolve once the first `(lldb)` prompt is live.
  static async launch(opts: LaunchOptions): Promise<PtyRepl> {
    opts.signal?.throwIfAborted();
    validateTimeout(opts.startupTimeoutMs ?? 90_000);
    const token = randomBytes(16).toString("hex");
    const args = [
      ...(IS_TS ? ["--import", "tsx"] : []),
      CLI,
      "--launch",
      "--port",
      "0",
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
      env: { ...process.env, [PTY_PROMPT_TOKEN_ENV]: token } as Record<string, string>,
    });
    const repl = new PtyRepl(child, ptyPromptMarker(token)!);
    const cancel = () => {
      void repl.shutdown().catch(() => {});
    };
    opts.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await repl.#waitForPrompt(1, opts.startupTimeoutMs ?? 90_000);
      opts.signal?.throwIfAborted();
      return repl;
    } catch (err) {
      const output = await repl.read(0);
      try {
        await repl.shutdown();
      } catch (cleanupError) {
        throw new PtyCleanupError([err, cleanupError], "PTY launch and rollback failed");
      }
      throw new Error(
        output
          ? `${err instanceof Error ? err.message : String(err)}: ${output}`
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      opts.signal?.removeEventListener("abort", cancel);
    }
  }

  // Send a command line and return the output it produced, once a fresh prompt
  // returns. `continue` has no prompt until the next stop, so a timeout here is
  // expected for a running target rather than an error.
  async send(command: string, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): Promise<SendResult> {
    validateTimeout(timeoutMs);
    this.#assertLive();
    if (command.length > 65536) throw new Error("REPL command exceeds 65536 characters");
    if (this.#queuedCommands >= 32) throw new Error("REPL command queue limit exceeded (32)");
    if (/[\r\n\x03]/.test(command))
      throw new Error("send accepts one command line; use interrupt for Ctrl-C");
    this.#queuedCommands++;
    const run = this.#sendQueue.then(async () => {
      this.#assertLive();
      if (this.#command || this.#interruptPromise)
        throw new Error(
          "REPL command is still running; use interrupt or read before sending another command"
        );
      const target = this.#promptTotal + 1;
      const mark = this.#endOffset();
      this.#command = { target, mark };
      this.#child.write(command + "\r");
      const prompt = await this.#waitForPrompt(target, timeoutMs).then(
        () => true,
        (error: unknown) => {
          if (error instanceof PromptTimeout) return false;
          throw error;
        }
      );
      const raw = this.#sliceFrom(mark);
      return { output: this.#clean(raw, command), prompt };
    });
    this.#sendQueue = run.then(
      () => {},
      () => {}
    );
    return run.finally(() => {
      this.#queuedCommands--;
    });
  }

  // Ctrl-C the running target, then wait for the stop output + prompt.
  interrupt(timeoutMs = 30_000): Promise<SendResult> {
    validateTimeout(timeoutMs);
    this.#assertLive();
    if (this.#interruptPromise) return this.#interruptPromise;
    const target = this.#command?.target ?? this.#promptTotal + 1;
    const mark = this.#command?.mark ?? this.#endOffset();
    return (this.#interruptPromise = Promise.resolve()
      .then(async () => {
        if (this.#promptTotal < target) this.#child.write("\x03");
        const prompt = await this.#waitForPrompt(target, timeoutMs).then(
          () => true,
          (error: unknown) => {
            if (error instanceof PromptTimeout) return false;
            throw error;
          }
        );
        const raw = this.#sliceFrom(mark);
        return { output: this.#clean(raw, ""), prompt };
      })
      .finally(() => {
        this.#interruptPromise = undefined;
      }));
  }

  // Drain any async output (streamed console messages, tab hints) without
  // sending a command. Waits up to timeoutMs for at least one new chunk.
  async read(timeoutMs = 2000): Promise<string> {
    validateTimeout(timeoutMs);
    if (this.#consumed >= this.#endOffset() && !this.#hasExited && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.#readWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.#readWaiters.add(finish);
      });
    }
    const slice = this.#sliceFrom(this.#consumed);
    this.#consumed = this.#endOffset();
    return this.#clean(slice, "");
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = Promise.resolve().then(() => this.#shutdown());
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    if (this.#hasExited) return;
    try {
      this.#child.write("quit\r");
    } catch {
      // pty may already be gone
    }
    const done = await this.#waitForExit(3000);
    if (!done) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // already dead
      }
      const killed = await this.#waitForExit(12_000);
      if (!killed) throw new Error("firefox-lldb PTY did not exit after kill");
    }
  }

  async #waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #assertLive(): void {
    if (this.#hasExited || this.#shutdownPromise) throw new Error("firefox-lldb PTY is closed");
  }

  // Only the CLI's private completion marker advances this sequence. Page
  // output and readline redraws can contain a literal prompt without completing work.
  #waitForPrompt(target: number, timeoutMs: number): Promise<void> {
    if (this.#hasExited) return Promise.reject(new Error("firefox-lldb PTY is closed"));
    if (this.#promptTotal >= target) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let waiter!: PromptWaiter;
      const timer = setTimeout(
        () => this.#settleWaiter(waiter, new PromptTimeout("prompt timeout")),
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
    let pending = this.#promptTail + data;
    let visible = "";
    for (;;) {
      const index = pending.indexOf(this.marker);
      if (index < 0) break;
      visible += pending.slice(0, index);
      pending = pending.slice(index + this.marker.length);
      this.#promptTotal++;
    }
    let suffix = Math.min(pending.length, this.marker.length - 1);
    while (suffix > 0 && !this.marker.startsWith(pending.slice(-suffix))) suffix--;
    this.#promptTail = suffix ? pending.slice(-suffix) : "";
    this.#out += visible + pending.slice(0, pending.length - suffix);
    if (this.#out.length > MAX_BUFFER_CHARS) {
      const drop = this.#out.length - MAX_BUFFER_CHARS;
      this.#out = this.#out.slice(drop);
      this.#outBase += drop;
    }
  }

  #endOffset(): number {
    return this.#outBase + this.#out.length;
  }

  #sliceFrom(offset: number): string {
    return (
      (offset < this.#outBase
        ? `[${this.#outBase - offset} earlier output characters omitted]\n`
        : "") + this.#out.slice(Math.max(0, offset - this.#outBase))
    );
  }

  // Strip ANSI, the leading echo of the typed command, and the trailing prompt
  // line so the agent sees just the command's output.
  #clean(raw: string, command: string): string {
    let s = stripAnsi(raw.split(this.marker).join("")).replace(/\r/g, "");
    if (command) {
      const lines = s.split("\n");
      if (lines[0]?.trim() === command.trim()) lines.shift();
      s = lines.join("\n");
    }
    return s.replace(/\n*\(lldb\)\s*$/, "").trim();
  }
}
