/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openSessionLog } from "../../src/cli/session-log.js";

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "helpers",
  "session-log-fatal-helper.ts"
);

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "session-log-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writes a header and per-kind records", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const log = openSessionLog(path, ["--launch", "--log"]);
    log.record("stdin", "b compute_factorial");
    log.record("stdout", "Breakpoint 1: where = math.wasm`compute_factorial");
    log.record("debug", '[rdp] >> {"to":"server1"}');
    log.close();

    const contents = readFileSync(path, "utf8");
    assert.match(contents, /^# firefox-lldb .* session log$/m);
    assert.match(contents, /^# argv: --launch --log$/m);
    assert.match(contents, /\d{2}:\d{2}:\d{2}\.\d{3} stdin\s+b compute_factorial$/m);
    assert.match(
      contents,
      /\d{2}:\d{2}:\d{2}\.\d{3} stdout\s+Breakpoint 1: where = math\.wasm`compute_factorial$/m
    );
    assert.match(contents, /\d{2}:\d{2}:\d{2}\.\d{3} debug\s+\[rdp] >> \{"to":"server1"}$/m);
  });
});

test("strips ANSI escapes and splits multi-line records", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const log = openSessionLog(path, []);
    log.record("stdout", "\x1b[31mline one\x1b[0m\nline two");
    log.close();

    const contents = readFileSync(path, "utf8");
    assert.ok(!contents.includes("\x1b"));
    assert.match(contents, /stdout\s+line one$/m);
    assert.match(contents, /stdout\s+line two$/m);
  });
});

test("captureStdio mirrors stderr into the log without dropping the original write", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const log = openSessionLog(path, []);

    // Stand in for the real fd write *before* captureStdio wraps it, so the
    // mirror's "original" is this spy and we can see what reaches it.
    const seen: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      seen.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      log.captureStdio();
      process.stderr.write("hello from stderr\n");
    } finally {
      log.close();
      process.stderr.write = originalWrite;
    }

    assert.deepEqual(seen, ["hello from stderr\n"]);
    const contents = readFileSync(path, "utf8");
    assert.match(contents, /stderr\s+hello from stderr$/m);
  });
});

test("captureStdio leaves stdout alone unless asked", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const log = openSessionLog(path, []);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      log.captureStdio();
      process.stdout.write("not captured\n");
    } finally {
      log.close();
      process.stdout.write = originalWrite;
    }

    const contents = readFileSync(path, "utf8");
    assert.ok(!contents.includes("not captured"));
  });
});

test("close() flushes a pending partial line", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const log = openSessionLog(path, []);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      log.captureStdio({ stdout: true });
      process.stdout.write("no trailing newline");
    } finally {
      log.close();
      process.stdout.write = originalWrite;
    }

    const contents = readFileSync(path, "utf8");
    assert.match(contents, /stdout\s+no trailing newline$/m);
  });
});

test("captureFatalErrors records an uncaught exception before the process exits", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      HELPER,
      path,
      "uncaughtException",
    ]);

    assert.equal(result.status, 1);
    const contents = readFileSync(path, "utf8");
    assert.match(contents, /stderr\s+Error: boom from helper$/m);
  });
});

test("captureFatalErrors records an unhandled promise rejection before the process exits", () => {
  withTmpDir((dir) => {
    const path = join(dir, "session.log");
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      HELPER,
      path,
      "unhandledRejection",
    ]);

    assert.equal(result.status, 1);
    const contents = readFileSync(path, "utf8");
    assert.match(contents, /stderr\s+Error: boom from helper$/m);
  });
});
