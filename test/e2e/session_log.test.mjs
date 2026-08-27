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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn } from "node-pty";
import { findFirefoxBinary } from "../../src/rdp/firefox.ts";
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

test("--log captures a full transcript while keeping the terminal clean", async (t) => {
  if (!findFirefoxBinary()) {
    t.skip("Firefox is not installed");
    return;
  }

  const fx = FIXTURES.factorial;
  const staticServer = await startStaticServer(fx.pageDir);
  const rdpPort = await freePort();

  // --log has no path argument (auto-named, relative to cwd), so run with cwd
  // set to the repo root — same as every other e2e test spawning this CLI —
  // and pick up the exact filename from the startup line it prints.
  const child = ptySpawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/firefox-lldb.ts",
      "--launch",
      "--headless",
      "--log",
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
    logPath = join(REPO, startupMatch[1]);

    await waitFor(
      () => out,
      (s) => s.includes("(lldb)")
    );

    child.write("breakpoint set -n " + fx.breakFunc + "\r");
    await waitFor(
      () => out,
      (s) => s.includes("Breakpoint 1")
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

    // The debug trace that went to the file must never have reached the pty.
    assert.doesNotMatch(stripAnsi(out), /\[debug]\s*\[rdp]/);
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
        } catch {
          rmSync(logPath);
        }
      } else {
        rmSync(logPath);
      }
    }
  }
});
