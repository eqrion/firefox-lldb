/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Architectural proof that two independently constructed wasm LLDB workers
// share one physical Firefox debuggee behind one SourceDebuggerSession. It
// covers isolation, module ownership, stop fan-out, driver handoff, and teardown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { parseCliArgs, startPlatformServer } from "../../src/core/platform-session.ts";
import { runRepl } from "../../src/cli/repl.ts";
import { IsolatedLldbComponentRuntime } from "../../src/source-debugger/lldb-isolate.ts";
import { SourceDebuggerSessionHost } from "../../src/source-debugger/host.ts";
import { SourceDebuggerSession } from "../../src/source-debugger/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { consoleLogger } from "../../src/cli/logger.ts";
import { startStaticServer, sleep } from "./harness.mjs";

const protocolLogger = {
  debug(message) {
    if (
      process.env.E2E_RUNTIME_VERBOSE &&
      /resume failed|evaluation failed|type":"(?:paused|resumed|resume)|resumeLimit/.test(message)
    ) {
      console.error(`[protocol] ${message}`);
    }
  },
  info() {},
  warn(message) {
    if (process.env.E2E_RUNTIME_VERBOSE) console.error(`[protocol] ${message}`);
  },
  error(message) {
    console.error(`[protocol] ${message}`);
  },
};

async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startRepl(session) {
  const input = new PassThrough();
  let output = "";
  const waiters = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      waiters.splice(0).forEach((waiter) => waiter());
      callback();
    },
  });
  const repl = runRepl({ session, input, output: stream });
  const settledAfter = (mark) =>
    new Promise((resolve) => {
      const check = () => {
        if (
          output
            .slice(mark)
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
            .includes("(sdb) ")
        ) {
          resolve();
        } else {
          waiters.push(check);
        }
      };
      check();
    });
  repl.start();
  return {
    async type(line) {
      const mark = output.length;
      input.write(line + "\n");
      await deadline(
        settledAfter(mark),
        40_000,
        `REPL command timed out: ${line}; output: ${output.slice(mark).slice(-500)}`
      );
      return output.slice(mark).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    },
    close: () => repl.close(),
  };
}

test("two isolated LLDB components compose an interleaved stack over one Firefox tab", async () => {
  const staticServer = await startStaticServer("test/fixtures/two-components");
  const url = `http://127.0.0.1:${staticServer.port}/index.html`;
  const rdpPort = await freePort();
  const debuggeeHost = new SourceDebuggerSessionHost({ logger: protocolLogger });
  const primary = await IsolatedLldbComponentRuntime.create({
    host: debuggeeHost.forComponent("lldb-a"),
    id: "lldb-a",
    name: "LLDB A",
    exclusiveModules: true,
    observerResumesTarget: false,
    logger: consoleLogger(Boolean(process.env.E2E_RUNTIME_VERBOSE)),
    verbose: Boolean(process.env.E2E_RUNTIME_VERBOSE),
  });
  const secondary = await IsolatedLldbComponentRuntime.create({
    host: debuggeeHost.forComponent("lldb-b"),
    id: "lldb-b",
    name: "LLDB B",
    exclusiveModules: true,
    observerResumesTarget: false,
    logger: consoleLogger(Boolean(process.env.E2E_RUNTIME_VERBOSE)),
    verbose: Boolean(process.env.E2E_RUNTIME_VERBOSE),
  });
  let primaryHandle;
  let secondaryHandle;
  let session;
  let primaryRdpSession;
  let repl;

  try {
    primaryHandle = await startPlatformServer(
      parseCliArgs([
        "--launch",
        "--headless",
        ...(process.env.E2E_VERBOSE ? ["--verbose"] : []),
        "--port",
        "0",
        "--rdp-port",
        String(rdpPort),
        "--url",
        url,
        "--fire",
        "runA()",
      ]),
      {
        wrapConnectPort: primary.bridgeTcp,
        onSession: (rdpSession) => {
          primaryRdpSession = rdpSession;
        },
        runControl: primary.runControl,
        moduleFilter: (moduleUrl) => moduleUrl.includes("component=a"),
        logger: protocolLogger,
      }
    );
    await primary.connectPlatform(primaryHandle.port);
    await primary.attach(1);

    secondaryHandle = await startPlatformServer(
      parseCliArgs([
        "--connect",
        ...(process.env.E2E_VERBOSE ? ["--verbose"] : []),
        "--port",
        "0",
        "--rdp-port",
        String(rdpPort),
      ]),
      {
        wrapConnectPort: secondary.bridgeTcp,
        sharedRdpSession: primaryRdpSession,
        runControl: secondary.runControl,
        moduleFilter: (moduleUrl) => moduleUrl.includes("component=b"),
        logger: protocolLogger,
      }
    );
    await secondary.connectPlatform(secondaryHandle.port);
    // Give the second platform watcher a chance to assign the existing tab's
    // stable pid before attach. attach() still retries the normal reload race.
    await sleep(250);
    await secondary.command("platform process list");
    await secondary.attach(1);

    session = new SourceDebuggerSession({
      components: [primary.component, secondary.component],
      getRdpSession: () => primaryRdpSession,
      resolveModuleOwner: async (module) =>
        module.url.includes("component=b") ? "lldb-b" : "lldb-a",
      debuggeeHost,
    });
    repl = startRepl(session);

    assert.deepEqual(
      (await session.components()).map(({ id }) => id),
      ["lldb-a", "lldb-b"]
    );
    assert.notEqual((await primary.component.state("stop-0")).reason.kind, "none");
    assert.notEqual((await secondary.component.state("stop-0")).reason.kind, "none");
    assert.deepEqual(
      (await session.modules())
        .map(({ url: moduleUrl, owner }) => [
          new URL(moduleUrl).searchParams.get("component"),
          owner,
        ])
        .sort(),
      [
        ["a", "lldb-a"],
        ["b", "lldb-b"],
      ]
    );
    assert.match(await repl.type("components"), /lldb-a\s+LLDB A.*lldb-b\s+LLDB B/s);
    const moduleOutput = await repl.type("modules");
    assert.match(moduleOutput, /component=a\s+\[lldb-a\]/);
    assert.match(moduleOutput, /component=b\s+\[lldb-b\]/);

    assert.match(
      await repl.type("break lldb-a::compute_factorial"),
      /Breakpoint lldb-a:1: verified/
    );
    assert.match(
      await repl.type("break lldb-b::compute_factorial"),
      /Breakpoint lldb-b:1: verified/
    );

    const stopOutput = await repl.type("continue lldb-a");
    assert.match(stopOutput, /compute_factorial/);
    assert.equal((await session.state()).reason.kind, "breakpoint");
    assert.notEqual(
      (await secondary.component.state(session.currentStopId())).reason.kind,
      "running"
    );
    const frames = await session.frames();
    assert.equal(frames.filter(({ componentId }) => componentId === "lldb-a").length, 1);
    assert.equal(frames.filter(({ componentId }) => componentId === "lldb-b").length, 0);
    assert.match(frames[0].functionName, /compute_factorial/);

    // Hand the next run to B while A is stopped on its own breakpoint. LLDB-A
    // internally single-steps off that site before issuing its observer
    // continue; only B owns the shared physical resume lease. The next call
    // leaves A live beneath a JavaScript import which enters B.
    // Schedule rather than invoke synchronously: RDP console evaluation can
    // run page code while Firefox is paused, before the next all-stop listener
    // and physical resume have been armed.
    await primaryRdpSession.evaluate("setTimeout(() => runInterleaved(), 100)");
    const secondStopOutput = await repl.type("continue lldb-b");
    assert.match(secondStopOutput, /compute_factorial/);
    assert.equal(
      (await secondary.component.state(session.currentStopId())).reason.kind,
      "breakpoint"
    );

    // Each LLDB sees the same physical stack but only exports source frames
    // for its owned module; SourceDebuggerSession merges them by physical
    // frame position and routes variables back to the appropriate LLDB.
    const mixedFrames = await session.frames();
    assert.deepEqual(
      mixedFrames.map(({ componentId }) => componentId),
      ["lldb-b", "lldb-a"]
    );
    assert.match(mixedFrames[0].functionName, /compute_factorial/);
    assert.match(mixedFrames[1].functionName, /call_other_factorial/);
    assert.ok(mixedFrames[0].physicalFrameIndex < mixedFrames[1].physicalFrameIndex);
    assert.match(
      await repl.type("bt"),
      /#0 .*compute_factorial.*\[lldb-b\].*#1 .*call_other_factorial.*\[lldb-a\]/s
    );

    const bLocals = await session.scopes(mixedFrames[0].id);
    const aLocals = await session.scopes(mixedFrames[1].id);
    assert.equal(
      bLocals.flatMap(({ values }) => values).find(({ name }) => name === "n")?.value.display,
      "6"
    );
    assert.equal(
      aLocals.flatMap(({ values }) => values).find(({ name }) => name === "n")?.value.display,
      "7"
    );
    assert.match(await repl.type("frame 0"), /#0 .*compute_factorial.*\[lldb-b\]/);
    assert.match(await repl.type("locals"), /\bn\s*=\s*6\b/);
    assert.match(await repl.type("frame 1"), /#1 .*call_other_factorial.*\[lldb-a\]/);
    assert.match(await repl.type("locals"), /\bn\s*=\s*7\b/);
    await repl.type("frame 0");

    // LLDB-B's StepOut uses multiple physical stop/resume cycles internally.
    // The session must keep LLDB-A observing each cycle without allowing its
    // first intermediate stop to abort B's active thread plan.
    const stepOutput = await repl.type("finish");
    assert.match(stepOutput, /stop reason = (?:wasm )?step/);
    assert.equal((await secondary.component.state(session.currentStopId())).reason.kind, "step");
    const framesAfterStepOut = await session.frames();
    assert.equal(
      framesAfterStepOut.some(({ componentId }) => componentId === "lldb-b"),
      false,
      "LLDB-B still owns a frame after stepping out of its outermost Wasm activation"
    );
    assert.equal(
      framesAfterStepOut.some(({ componentId }) => componentId === "lldb-a"),
      true,
      "LLDB-A lost the suspended caller while LLDB-B stepped out"
    );
  } finally {
    repl?.close();
    await session?.close().catch(() => {});
    debuggeeHost.close();
    await Promise.allSettled([
      primary.close(),
      secondary.close(),
      secondaryHandle?.shutdown(),
      primaryHandle?.shutdown(),
    ]);
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
});
