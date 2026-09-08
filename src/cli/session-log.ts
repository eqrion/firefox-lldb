/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Session transcript for bug reports: everything the user typed, everything
// printed back, and the debug stream that `-v` would otherwise dump over the
// prompt, all in one file. Records are written synchronously (buffered) because
// both CLIs exit via process.exit(), which truncates an async write stream.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefoxLogDir } from "../config.js";

export type LogKind = "stdin" | "stdout" | "stderr" | "debug";

export interface SessionLog {
  path: string;
  record(kind: LogKind, text: string): void;
  /** Most recent formatted records, newest last. */
  tail(limit?: number): string[];
  /** Mirror process.stderr writes (and stdout when asked) into the log. */
  captureStdio(opts?: { stdout?: boolean }): void;
  close(opts?: { remove?: boolean }): void;
}

const FLUSH_THRESHOLD_BYTES = 8 * 1024;
const FLUSH_INTERVAL_MS = 500;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** ./firefox-lldb-<YYYYMMDD-HHMMSS>-<pid>.log */
export function defaultLogPath(): string {
  const d = new Date();
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `firefox-lldb-${stamp}-${process.pid}.log`;
}

/** Default always-on transcript location. Removed after a clean run. */
export function temporaryLogPath(): string {
  const dir = firefoxLogDir() ?? tmpdir();
  mkdirSync(dir, { recursive: true });
  return join(dir, defaultLogPath());
}

function toolVersion(): string {
  try {
    const pkg = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(pkg) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Open `path` for a new transcript. Throws if it cannot be written. */
export function openSessionLog(path: string, argv: string[]): SessionLog {
  const fd = openSync(path, "w");
  let buffer = "";
  let bufferedBytes = 0;
  let closed = false;
  const recent: string[] = [];
  const keepRecent = 100;

  const flush = (): void => {
    if (!buffer) return;
    const pending = buffer;
    buffer = "";
    bufferedBytes = 0;
    try {
      writeSync(fd, pending);
    } catch {
      // A failing transcript must not take the debug session down with it.
    }
  };

  const append = (text: string): void => {
    if (closed) return;
    buffer += text;
    bufferedBytes += text.length;
    if (bufferedBytes >= FLUSH_THRESHOLD_BYTES) flush();
  };

  const record = (kind: LogKind, text: string): void => {
    const clean = text.replace(ANSI, "");
    const now = new Date();
    const p = (n: number, width = 2) => String(n).padStart(width, "0");
    const stamp = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(
      now.getMilliseconds(),
      3
    )}`;
    // One line per record so the file stays greppable.
    for (const line of clean.replace(/\n$/, "").split("\n")) {
      const formatted = `${stamp} ${kind.padEnd(6)} ${line}`;
      append(`${formatted}\n`);
      recent.push(formatted);
      if (recent.length > keepRecent) recent.splice(0, recent.length - keepRecent);
    }
  };

  append(
    `# firefox-lldb ${toolVersion()} session log\n` +
      `# started ${new Date().toISOString()}\n` +
      `# argv: ${argv.join(" ")}\n` +
      `# node ${process.version} ${process.platform} ${process.arch}\n` +
      `# NOTE: may contain page content, console output, and protocol data.\n`
  );

  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  timer.unref();
  const onExit = () => flush();
  process.on("exit", onExit);

  const restores: (() => void)[] = [];

  const mirror = (stream: NodeJS.WriteStream, kind: LogKind): void => {
    const original = stream.write.bind(stream);
    // Writes arrive in arbitrary chunks; hold a partial line back so records
    // are whole lines.
    let partial = "";
    const write = ((chunk: unknown, ...rest: unknown[]) => {
      const result = (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      const text =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
      if (text) {
        partial += text;
        const lastBreak = partial.lastIndexOf("\n");
        if (lastBreak !== -1) {
          record(kind, partial.slice(0, lastBreak));
          partial = partial.slice(lastBreak + 1);
        }
      }
      return result;
    }) as typeof stream.write;
    stream.write = write;
    restores.push(() => {
      if (partial) record(kind, partial);
      stream.write = original as typeof stream.write;
    });
  };

  return {
    path,
    record,
    tail(limit = 20) {
      return recent.slice(-Math.max(0, limit));
    },
    captureStdio(opts) {
      mirror(process.stderr, "stderr");
      if (opts?.stdout) mirror(process.stdout, "stdout");
    },
    close(opts) {
      if (closed) return;
      for (const restore of restores.splice(0).reverse()) restore();
      clearInterval(timer);
      process.off("exit", onExit);
      flush();
      closed = true;
      closeSync(fd);
      if (opts?.remove) rmSync(path, { force: true });
    },
  };
}

/** Render an error with the tail and the location of the complete transcript. */
export function formatErrorWithLog(error: unknown, sessionLog: SessionLog, keep = 20): string {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const tail = sessionLog.tail(keep);
  const recent = tail.length
    ? `\nLast ${tail.length} session log lines:\n${tail.join("\n")}`
    : "\nSession log has no diagnostic records.";
  return `${message}${recent}\nFull session log retained at ${sessionLog.path}`;
}

/**
 * Node's default uncaughtException/unhandledRejection printer writes straight
 * to the stderr file descriptor, bypassing process.stderr.write (and so
 * captureStdio's mirror) entirely. Without this, a genuine crash never
 * appears in the transcript even though it's exactly what a bug report needs.
 */
export function captureFatalErrors(sessionLog: SessionLog): void {
  const handle = (err: unknown): void => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    sessionLog.record("stderr", text);
    console.error(err);
    console.error(`Full session log retained at ${sessionLog.path}`);
    sessionLog.close();
    process.exit(1);
  };
  process.on("uncaughtException", handle);
  process.on("unhandledRejection", handle);
}
