/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Spawned by repl-pty.test.ts via node-pty. Runs the REPL against stdin/stdout
// (which node-pty connects to a PTY slave) with a fake LLDBClient whose "c"
// command blocks until onTargetInterrupt releases it.

import { runRepl } from "../../src/cli/repl.js";
import type { LLDBClient } from "lldb-wasm";

let releaseCmd: ((v: { output: string; error: string; status: number }) => void) | null = null;

const client = {
  sessionCommand: (cmd: string) => {
    if (cmd === "c" || cmd === "continue" || cmd === "process continue") {
      return new Promise<{ output: string; error: string; status: number }>((r) => {
        releaseCmd = r;
      });
    }
    return Promise.resolve({ output: "", error: "", status: 0 });
  },
  pause: async () => {},
} as unknown as LLDBClient;

const repl = runRepl({
  client,
  getSession: () => undefined,
  onExit: () => process.exit(0),
  onTargetInterrupt: () => {
    releaseCmd?.({ output: "Process 1 stopped.\n", error: "", status: 0 });
    releaseCmd = null;
  },
});

repl.start();
