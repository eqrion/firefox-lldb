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
import type { RdpWasmSession } from "../../src/rdp/session.js";
import type { SourceDebuggerSession } from "../../src/source-debugger/session.js";

const stripAnsi = (s: string) => s.replace(/\[[0-9;?]*[A-Za-z]/g, "");
const tick = () => new Promise<void>((r) => setImmediate(r));

interface FakeClient {
  sessionCommand: (cmd: string) => Promise<{ output: string; error: string; status: number }>;
  pause: () => Promise<void>;
}

type ExtraOpts = {
  onTargetInterrupt?: () => void;
  onTargetResume?: () => void;
  sourceSession?: Record<string, unknown>;
};

function harness(client: FakeClient, session?: Partial<RdpWasmSession>, extra?: ExtraOpts) {
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
  const debuggerSession = {
    rdpSession: () => session,
    command: (command: string) => client.sessionCommand(command),
    cancelActiveRun: () => client.pause(),
    components: async () => [{ id: "lldb", name: "LLDB", protocolVersion: "0.1" }],
    componentStatuses: async () => [
      {
        id: "lldb",
        status: "ready",
        descriptor: { id: "lldb", name: "LLDB", protocolVersion: "0.1" },
      },
    ],
    modules: async () => [],
    threads: async () => [{ id: "1", stopped: true }],
    frames: async () => [],
    scopes: async () => [],
    evaluate: async () => null,
    setBreakpoint: async () => {
      throw new Error("not implemented by fake");
    },
    breakpoints: async () => [],
    removeBreakpoint: async () => {},
    continue: async () => {
      const result = await client.sessionCommand("process continue");
      return { stopId: "stop-1", reason: { kind: "stopped" }, output: result.output };
    },
    stepInto: async () => ({ stopId: "stop-1", reason: { kind: "step" } }),
    stepOver: async () => ({ stopId: "stop-1", reason: { kind: "step" } }),
    stepOut: async () => ({ stopId: "stop-1", reason: { kind: "step" } }),
    ...extra?.sourceSession,
  } as unknown as SourceDebuggerSession;
  const repl = runRepl({
    session: debuggerSession,
    input,
    output,
    onExit: () => {
      exited = true;
    },
    ...(extra?.onTargetInterrupt ? { onTargetInterrupt: extra.onTargetInterrupt } : {}),
    ...(extra?.onTargetResume ? { onTargetResume: extra.onTargetResume } : {}),
  });
  const settle = () =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (stripAnsi(out).trimEnd().endsWith("(sdb)")) resolve();
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

test("components reports healthy and quarantined debugger isolates", async () => {
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    undefined,
    {
      sourceSession: {
        componentStatuses: async () => [
          {
            id: "lldb-a",
            status: "ready",
            descriptor: { id: "lldb-a", name: "LLDB A", protocolVersion: "0.1" },
          },
          {
            id: "lldb-b",
            status: "quarantined",
            descriptor: { id: "lldb-b", name: "LLDB B", protocolVersion: "0.1" },
            message: "SourceDebuggerComponent RPC peer closed",
          },
        ],
      },
    }
  );
  await h.start();

  const out = await h.type("components");
  assert.match(out, /lldb-a\s+LLDB A\s+protocol 0\.1/);
  assert.match(out, /lldb-b\s+LLDB B\s+quarantined: .*peer closed/);
});

test("component-qualified commands route ambiguous operations", async () => {
  let breakpointComponent: string | undefined;
  let continueDriver: string | undefined;
  let nativeRoute: [string, string | undefined] | undefined;
  let stepIntoFrame: string | undefined;
  let steppedFrame: string | undefined;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    undefined,
    {
      sourceSession: {
        setBreakpoint: async (request: { componentId?: string; target: unknown }) => {
          breakpointComponent = request.componentId;
          return {
            id: "lldb-b:1",
            componentId: "lldb-b",
            verified: true,
            target: request.target,
          };
        },
        continue: async (componentId?: string) => {
          continueDriver = componentId;
          return { stopId: "stop-1", reason: { kind: "breakpoint" } };
        },
        command: async (command: string, componentId?: string) => {
          nativeRoute = [command, componentId];
          return { output: "native ok", error: "", status: 0 };
        },
        stepInto: async (frameId?: string) => {
          stepIntoFrame = frameId;
          return { stopId: "stop-1", reason: { kind: "step" } };
        },
        frames: async () => [
          {
            id: "logical-b-frame",
            stopId: "stop-0",
            threadId: "1",
            componentId: "lldb-b",
            componentFrameId: "0",
            physicalFrameIndex: 0,
            inlineFrameIndex: 0,
            functionName: "compute_factorial",
            inline: false,
          },
        ],
        stepOut: async (frameId?: string) => {
          steppedFrame = frameId;
          return { stopId: "stop-1", reason: { kind: "step" } };
        },
      },
    }
  );
  await h.start();

  assert.match(await h.type("break lldb-b::compute_factorial"), /lldb-b:1: verified/);
  assert.equal(breakpointComponent, "lldb-b");
  await h.type("continue lldb-b");
  assert.equal(continueDriver, "lldb-b");
  await h.type("step");
  assert.equal(stepIntoFrame, "logical-b-frame");
  assert.match(await h.type("lldb lldb-b::thread list"), /native ok/);
  assert.deepEqual(nativeRoute, ["thread list", "lldb-b"]);
  await h.type("frame 0");
  await h.type("finish");
  assert.equal(steppedFrame, "logical-b-frame");
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

test("js frame with out-of-range index prints an error", async () => {
  const session = {
    paused: () => true,
    stoppedTid: 1,
    frames: async () => [
      { actor: "f0", type: "call", displayName: "foo", where: { actor: "s", line: 10, column: 0 } },
    ],
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js frame 99");
  assert.match(out, /no frame 99/);
});

test("js p with no expression prints usage", async () => {
  const session = {
    paused: () => true,
    stoppedTid: 1,
    frames: async () => [],
    stoppedConsoleActor: "console1",
  } as unknown as RdpWasmSession;
  const h = harness(
    okClient(() => ({ output: "", error: "", status: 0 })),
    session
  );
  await h.start();
  const out = await h.type("js p");
  assert.match(out, /expression required/i);
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

test("Ctrl-C calls onTargetInterrupt not pause() when callback is provided", async () => {
  let interruptCalled = false;
  let pauseCalled = false;
  let release!: (v: { output: string; error: string; status: number }) => void;
  const client: FakeClient = {
    sessionCommand: (cmd) =>
      cmd === "process continue"
        ? new Promise((r) => (release = r))
        : Promise.resolve({ output: "", error: "", status: 0 }),
    pause: async () => {
      pauseCalled = true;
    },
  };
  const h = harness(client, undefined, {
    onTargetInterrupt: () => {
      interruptCalled = true;
      release({ output: "Process stopped.\n", error: "", status: 0 });
    },
  });
  await h.start();
  const typed = h.type("c");
  await tick();
  await tick();
  h.interrupt();
  const out = await typed;
  assert.ok(interruptCalled, "onTargetInterrupt should be called");
  assert.ok(!pauseCalled, "pause() must not be called when onTargetInterrupt is provided");
  assert.match(out, /Process stopped/);
  assert.ok(!h.exited);
});

test("continue commands print 'Process running.' and call onTargetResume", async () => {
  let resumeCalled = false;
  const h = harness(
    okClient(() => ({ output: "Process stopped.\n", error: "", status: 0 })),
    undefined,
    {
      onTargetResume: () => {
        resumeCalled = true;
      },
    }
  );
  await h.start();
  const out = await h.type("c");
  assert.ok(resumeCalled, "onTargetResume should be called for a continue command");
  assert.match(out, /Process running\./);
  assert.match(out, /Process stopped\./);
});
