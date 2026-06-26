/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// PTY-based tests for the REPL's Ctrl-C interrupt handling. These use
// node-pty to spawn the REPL helper in a real pseudo-terminal, which means
// readline sees a genuine TTY (isTTY=true, setRawMode path) rather than the
// stream-injection path used by repl.test.ts. The two harnesses test
// different code paths inside readline.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, "..", "helpers", "repl-pty-helper.ts");

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function waitFor(
  getOutput: () => string,
  pred: (s: string) => boolean,
  ms = 4000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      if (pred(stripAnsi(getOutput()))) return resolve();
      if (Date.now() >= deadline) {
        return reject(
          new Error(`waitFor timeout; last output: ${JSON.stringify(getOutput().slice(-300))}`)
        );
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("PTY: Ctrl-C interrupts a running target via onTargetInterrupt", async (t: TestContext) => {
  if (process.platform === "win32") {
    t.skip("PTY test not supported on Windows");
    return;
  }

  let ptyMod: typeof import("node-pty");
  try {
    ptyMod = await import("node-pty");
  } catch {
    t.skip("node-pty not installed");
    return;
  }

  const child = ptyMod.spawn("node", ["--import", "tsx", HELPER], {
    cols: 80,
    rows: 24,
    env: process.env as Record<string, string>,
  });

  let out = "";
  child.onData((d) => (out += d));

  try {
    await waitFor(() => out, (s) => s.includes("(lldb)"));

    child.write("c\r");
    await waitFor(() => out, (s) => s.includes("Process running."));

    child.write("\x03");
    await waitFor(() => out, (s) => s.includes("Process 1 stopped."));

    // Prompt should return (REPL must not exit)
    await waitFor(() => out, (s) => {
      const idx = s.indexOf("Process 1 stopped.");
      return idx !== -1 && s.slice(idx).includes("(lldb)");
    });

    assert.match(stripAnsi(out), /Process 1 stopped\./);
    assert.doesNotMatch(stripAnsi(out), /\^C again to quit/);
  } finally {
    child.kill();
  }
});
