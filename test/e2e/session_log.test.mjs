/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// End-to-end coverage of `--log`: spawns the real firefox-lldb CLI in a pty
// (the same way src/mcp/pty-repl.ts does) so the terminal-facing readline path
// is exercised, then checks the transcript file it wrote. The point of the
// feature is that debug trace lands in the file but never on the terminal, so
// this asserts both sides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { spawn as ptySpawn } from "node-pty";
import { findFirefoxBinary } from "../../src/core/firefox.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { FIXTURES, startStaticServer } from "./harness.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function waitFor(getOutput, pred, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      if (pred(stripAnsi(getOutput()))) return resolve();
      if (Date.now() >= deadline) {
        return reject(
          new Error(`waitFor timeout; last output: ${JSON.stringify(getOutput().slice(-500))}`)
        );
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

test("a failed default CLI run retains its temporary transcript and prints the tail", async (t) => {
  // Keep stdin open: EOF is a shutdown request, which now cancels acquisition
  // before the deliberately invalid binary necessarily reaches spawn().
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/firefox-lldb.ts",
      "--launch",
      "--headless",
      "--firefox",
      "/definitely/not/a/firefox-binary",
      "--port",
      "0",
      "--rdp-port",
      "6080",
    ],
    { cwd: REPO, env: process.env, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const [code] = await exited;
  assert.equal(code, 1, output);
  assert.match(output, /Last \d+ session log lines:/);
  const match = output.match(/Full session log retained at (\S+\.log)/);
  assert.ok(match, output);
  const logPath = match[1];
  try {
    assert.equal(existsSync(logPath), true);
    assert.match(readFileSync(logPath, "utf8"), /could not start Firefox/);
  } finally {
    rmSync(logPath, { force: true });
  }
});

test("--log captures a full transcript while keeping the terminal clean", async (t) => {
  if (!findFirefoxBinary()) {
    t.skip("Firefox is not installed");
    return;
  }

  const fx = FIXTURES.factorial;
  const staticServer = await startStaticServer(fx.pageDir);
  const platformPort = await freePort();
  const rdpPort = await freePort();

  // --log names the file automatically, in FIREFOX_LLDB_LOG_DIR when set or
  // cwd otherwise. Read the actual path from the startup line.
  const child = ptySpawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/firefox-lldb.ts",
      "--launch",
      "--headless",
      "--log",
      "--port",
      String(platformPort),
      "--rdp-port",
      String(rdpPort),
      "--url",
      `http://127.0.0.1:${staticServer.port}/index.html`,
    ],
    { name: "xterm-color", cols: 120, rows: 40, cwd: REPO, env: process.env }
  );

  let out = "";
  child.onData((d) => (out += d));
  let logPath;
  let keepLog = false;

  try {
    // Learn the log path before waiting on the prompt. An attach that never
    // reaches `(lldb)` is exactly when the transcript is worth keeping, and it
    // cannot be kept if this runs after the wait that timed out.
    await waitFor(
      () => out,
      (s) => /logging this session to \S+\.log/.test(stripAnsi(s))
    );
    const startupMatch = stripAnsi(out).match(/logging this session to (\S+\.log)/);
    assert.ok(startupMatch, `startup path line not printed; output: ${stripAnsi(out)}`);
    logPath = resolve(REPO, startupMatch[1]);

    await waitFor(
      () => out,
      (s) => s.includes("(lldb)")
    );

    child.write("breakpoint set -n " + fx.breakFunc + "\r");
    await waitFor(
      () => out,
      (s) => s.includes("Breakpoint 1")
    );

    // A user command failure remains visible once, while LLDB's duplicate
    // operation.failed diagnostic stays in the transcript even without -v.
    child.write("this_command_does_not_exist\r");
    await waitFor(
      () => out,
      (s) => /not a valid command|unknown command/.test(s)
    );

    child.write("quit\r");
    const exited = new Promise((resolve) => child.onExit(resolve));
    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 30_000)),
    ]);
    if (result === timedOut) throw new Error("firefox-lldb did not exit after `quit`");

    assert.ok(existsSync(logPath), `log file missing: ${logPath}`);
    const contents = readFileSync(logPath, "utf8");

    assert.match(contents, /^# firefox-lldb .* session log$/m);
    assert.match(contents, new RegExp(`stdin\\s+breakpoint set -n ${fx.breakFunc}$`, "m"));
    assert.match(contents, /stdout\s+Breakpoint 1/m);
    assert.match(contents, /debug\s+\[rdp] >>/m);
    assert.match(contents, /debug\s+\[lldb-wasm] worker\.started /m);
    assert.match(contents, /debug\s+\[lldb-wasm] operation\.completed /m);
    assert.match(contents, /debug\s+\[lldb-wasm] operation\.failed /m);
    assert.match(contents, /debug\s+\[bridge platform] LLDB->TCP RSP/);
    assert.match(contents, /debug\s+\[bridge tab-1] TCP->LLDB RSP/);
    assert.match(contents, /channel\.closed/);

    // The debug trace that went to the file must never have reached the pty.
    assert.doesNotMatch(stripAnsi(out), /\[debug]\s*\[rdp]/);
    assert.doesNotMatch(stripAnsi(out), /\[lldb-wasm]/);
  } catch (err) {
    // The log is a full RDP transcript of whatever went wrong, and this test is
    // one of the few that drives a real attach with no retry. Keep it where CI's
    // artifact step will collect it instead of deleting the only evidence.
    keepLog = true;
    throw err;
  } finally {
    if (!child.killed) child.kill();
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
    if (logPath && existsSync(logPath)) {
      const keepDir = keepLog ? process.env.FIREFOX_LLDB_LOG_DIR : undefined;
      if (keepDir) {
        try {
          mkdirSync(keepDir, { recursive: true });
          renameSync(logPath, join(keepDir, basename(logPath)));
        } catch (error) {
          console.error(`Could not move failed transcript; retained at ${logPath}: ${error}`);
        }
      } else if (!keepLog) {
        rmSync(logPath);
      } else {
        console.error(`Failed transcript retained at ${logPath}`);
      }
    }
  }
});
