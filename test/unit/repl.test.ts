/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Deterministic coverage of the REPL command routing, js subcommands, console
// muting, and Ctrl-C handling. Uses fake client/session objects and injected
// streams, so it needs no Firefox and runs in the plain unit suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { runRepl } from "../../src/cli/repl.js";
import type { LLDBClient } from "lldb-wasm";
import type { RdpWasmSession } from "../../src/rdp/session.js";

const stripAnsi = (s: string) => s.replace(/\[[0-9;?]*[A-Za-z]/g, "");
const tick = () => new Promise<void>((r) => setImmediate(r));

interface FakeClient {
  sessionCommand: (cmd: string) => Promise<{ output: string; error: string; status: number }>;
  pause: () => Promise<void>;
}

function harness(client: FakeClient, session?: Partial<RdpWasmSession>) {
  const input = new PassThrough();
  let out = "";
  let exited = false;
  const waiters: (() => void)[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      waiters.splice(0).forEach((w) => w());
      cb();
    },
  });
  const repl = runRepl({
    client: client as unknown as LLDBClient,
    getSession: () => session as RdpWasmSession | undefined,
    input,
    output,
    onExit: () => {
      exited = true;
    },
  });
  const settle = () =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (stripAnsi(out).trimEnd().endsWith("(lldb)")) resolve();
        else waiters.push(check);
      };
      check();
    });
  return {
    repl,
    get exited() {
      return exited;
    },
    all() {
      return stripAnsi(out);
    },
    async start() {
      repl.start();
      await settle();
    },
    async type(line: string): Promise<string> {
      const mark = out.length;
      input.write(line + "\n");
      await settle();
      return stripAnsi(out.slice(mark));
    },
    interrupt() {
      input.write("\x03");
    },
  };
}

const okClient = (
  fn: (cmd: string) => { output: string; error: string; status: number }
): FakeClient => ({
  sessionCommand: async (cmd) => fn(cmd),
  pause: async () => {},
});

test("a plain command is routed to sessionCommand and its output printed", async () => {
  const h = harness(
    okClient(() => ({ output: "Breakpoint 1: where = math`foo\n", error: "", status: 0 }))
  );
  await h.start();
  const out = await h.type("breakpoint set -n foo");
  assert.match(out, /Breakpoint 1: where = math`foo/);
});

test("command error text is surfaced", async () => {
  const h = harness(okClient(() => ({ output: "", error: "error: no such command\n", status: 4 })));
  await h.start();
  const out = await h.type("bogus");
  assert.match(out, /no such command/);
});

test("js p evaluates and prints the result", async () => {
  const session = {
    paused: () => false,
    stoppedTid: 1,
    stoppedConsoleActor: "c1",
    evalJS: async () => ({ result: 42 }),
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js p 6*7");
  assert.match(out, /\b42\b/);
});

test("js p reports an evaluation exception", async () => {
  const session = {
    paused: () => false,
    stoppedTid: 1,
    stoppedConsoleActor: null,
    evalJS: async () => ({ exceptionMessage: "ReferenceError: x is not defined" }),
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js p x");
  assert.match(out, /ReferenceError/);
});

test("js bt lists JS frames", async () => {
  const session = {
    paused: () => true,
    stoppedTid: 1,
    frames: async () => [
      { actor: "f0", type: "call", displayName: "foo", where: { actor: "s", line: 10, column: 3 } },
      { actor: "f1", type: "call", displayName: "bar", where: { actor: "s", line: 2, column: 1 } },
    ],
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js bt");
  assert.match(out, /#0: foo at 10:3/);
  assert.match(out, /#1: bar at 2:1/);
});

test("js frame prints the frame and its locals", async () => {
  const session = {
    paused: () => true,
    stoppedTid: 1,
    frames: async () => [
      { actor: "f0", type: "call", displayName: "foo", where: { actor: "s", line: 10, column: 3 } },
    ],
    frameEnvironment: async () => ({
      bindings: { arguments: [{ n: { value: 5 } }], variables: { msg: { value: "hi" } } },
    }),
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js frame 0");
  assert.match(out, /#0: foo/);
  assert.match(out, /n = 5/);
  assert.match(out, /msg = hi/);
});

test("js with no attached tab is reported", async () => {
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    undefined
  );
  await h.start();
  const out = await h.type("js p 1");
  assert.match(out, /no attached tab/);
});

test("console off mutes streamed console output, console on restores it", async () => {
  const h = harness(okClient(() => ({ output: "", error: "", status: 0 })));
  await h.start();
  h.repl.printConsole("console.log: one");
  await tick();
  await h.type("console off");
  h.repl.printConsole("console.log: two");
  await tick();
  await h.type("console on");
  h.repl.printConsole("console.log: three");
  await tick();
  const all = h.all();
  assert.match(all, /console\.log: one/);
  assert.doesNotMatch(all, /console\.log: two/);
  assert.match(all, /console\.log: three/);
});

test("Ctrl-C while a target is running interrupts instead of exiting", async () => {
  let pauseCalled = false;
  let release!: (v: { output: string; error: string; status: number }) => void;
  const client: FakeClient = {
    sessionCommand: (cmd) =>
      cmd === "process continue"
        ? new Promise((r) => (release = r))
        : Promise.resolve({ output: "", error: "", status: 0 }),
    pause: async () => {
      pauseCalled = true;
      release({ output: "Process 1 stopped (signal SIGSTOP)\n", error: "", status: 0 });
    },
  };
  const h = harness(client);
  await h.start();
  // Start the continue; it won't resolve until pause() releases it.
  const typed = h.type("process continue");
  await tick();
  await tick();
  h.interrupt();
  const out = await typed;
  assert.ok(pauseCalled, "pause() should be called on Ctrl-C while running");
  assert.match(out, /SIGSTOP/);
  assert.ok(!h.exited, "the REPL must stay alive after interrupting a running target");
});

test("two Ctrl-C at an idle empty prompt exit the REPL", async () => {
  const h = harness(okClient(() => ({ output: "", error: "", status: 0 })));
  await h.start();
  h.interrupt();
  await tick();
  h.interrupt();
  await tick();
  assert.ok(h.exited, "double Ctrl-C at an empty prompt should exit");
});
