/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Architectural proof that two independently constructed wasm LLDB workers
// share one physical Firefox debuggee behind one SourceDebuggerSession. It
// covers isolation, module ownership, stop fan-out, driver handoff, and teardown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, startPlatformServer } from "../../src/core/platform-session.ts";
import { EmbeddedLldbComponentRuntime } from "../../src/source-debugger/lldb-runtime.ts";
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

test("two isolated LLDB components own separate modules in one Firefox tab", async () => {
  const staticServer = await startStaticServer("test/fixtures/simple");
  const url = `http://127.0.0.1:${staticServer.port}/two-modules.html`;
  const rdpPort = await freePort();
  const primary = await EmbeddedLldbComponentRuntime.create({
    id: "lldb-a",
    name: "LLDB A",
    exclusiveModules: true,
    observerResumesTarget: false,
    logger: consoleLogger(Boolean(process.env.E2E_RUNTIME_VERBOSE)),
  });
  const secondary = await EmbeddedLldbComponentRuntime.create({
    id: "lldb-b",
    name: "LLDB B",
    exclusiveModules: true,
    observerResumesTarget: false,
    logger: consoleLogger(Boolean(process.env.E2E_RUNTIME_VERBOSE)),
  });
  let primaryHandle;
  let secondaryHandle;
  let session;
  let primaryRdpSession;

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
      selectModuleOwner: (module) => (module.url.includes("component=b") ? "lldb-b" : "lldb-a"),
    });

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

    const a = await session.setBreakpoint({
      componentId: "lldb-a",
      target: { kind: "function", name: "compute_factorial" },
    });
    const b = await session.setBreakpoint({
      componentId: "lldb-b",
      target: { kind: "function", name: "compute_factorial" },
    });
    assert.equal(a.id, "lldb-a:1");
    assert.equal(b.id, "lldb-b:1");
    assert.equal(a.verified, true);
    assert.equal(b.verified, true);

    const stop = await deadline(
      session.continue("lldb-a"),
      30_000,
      "two-component continue timed out"
    );
    assert.equal(stop.reason.kind, "breakpoint");
    assert.match(stop.output ?? "", /compute_factorial/);
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
    // continue; only B owns the shared physical resume lease.
    // Schedule rather than invoke synchronously: RDP console evaluation can
    // run page code while Firefox is paused, before the next all-stop listener
    // and physical resume have been armed.
    await primaryRdpSession.evaluate("setTimeout(() => runB(), 100)");
    const secondStop = await deadline(
      session.continue("lldb-b"),
      30_000,
      "reverse two-component continue timed out"
    );
    assert.equal(secondStop.reason.kind, "breakpoint");
    assert.match(secondStop.output ?? "", /compute_factorial/);

    const secondFrames = await session.frames();
    assert.equal(secondFrames.filter(({ componentId }) => componentId === "lldb-a").length, 0);
    assert.equal(secondFrames.filter(({ componentId }) => componentId === "lldb-b").length, 1);
    assert.match(secondFrames[0].functionName, /compute_factorial/);
    const locals = await session.scopes(secondFrames[0].id);
    assert.equal(
      locals.flatMap(({ values }) => values).find(({ name }) => name === "n")?.value.display,
      "8"
    );

    // Repeat the handoff in the other direction. This makes both LLDBs take
    // turns as the stopped observer which must retire its previous breakpoint
    // plan without stealing the shared physical resume lease.
    await primaryRdpSession.evaluate("setTimeout(() => runA(), 100)");
    const thirdStop = await deadline(
      session.continue("lldb-a"),
      30_000,
      "return two-component continue timed out"
    );
    assert.equal(thirdStop.reason.kind, "breakpoint");
    assert.match(thirdStop.output ?? "", /compute_factorial/);

    const thirdFrames = await session.frames();
    assert.equal(thirdFrames.filter(({ componentId }) => componentId === "lldb-a").length, 1);
    assert.equal(thirdFrames.filter(({ componentId }) => componentId === "lldb-b").length, 0);
    const thirdLocals = await session.scopes(thirdFrames[0].id);
    assert.equal(
      thirdLocals.flatMap(({ values }) => values).find(({ name }) => name === "n")?.value.display,
      "10"
    );
  } finally {
    await session?.close().catch(() => {});
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
