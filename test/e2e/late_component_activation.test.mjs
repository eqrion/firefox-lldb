/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A second artifact ecosystem appears after startup. The catalog definition
// exists from the beginning, but its isolated wasm LLDB must not exist until a
// stopped module refresh selects it. It then joins the next run as an observer.

import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../../src/cli/options.ts";
import { freePort } from "../../src/net/free-port.ts";
import { createRoutedModuleOwnerResolver } from "../../src/source-debugger/config.ts";
import { FirefoxSourceDebuggerTarget } from "../../src/source-debugger/target/firefox/target.ts";
import {
  LldbSourceDebuggerComponentLoader,
  LldbComponentActivator,
} from "../../src/source-debugger/components/lldb/loader.ts";
import { SourceDebuggerSessionRuntime } from "../../src/source-debugger/session/runtime.ts";
import { startStaticServer } from "./harness.mjs";

test("a late Wasm module activates a second isolated LLDB at the current stop", async () => {
  const staticServer = await startStaticServer("test/fixtures/two-components");
  const routes = [
    { id: "lldb-a", urlSubstring: "component=a" },
    { id: "lldb-b", urlSubstring: "component=b" },
  ];
  let target;
  let runtime;
  try {
    const args = parseCliArgs([
      "--launch",
      "--headless",
      "--rdp-port",
      String(await freePort()),
      "--url",
      `http://127.0.0.1:${staticServer.port}/lazy.html`,
    ]);
    target = await FirefoxSourceDebuggerTarget.start({ ...args });
    trace("browser target ready");
    const lldbActivator = new LldbComponentActivator({
      automaticAttach: target.automaticAttach,
      onDetached: (listener) => void target.onDetached(listener),
    });
    const loaders = routes.map(
      (route) =>
        new LldbSourceDebuggerComponentLoader(lldbActivator, route, {
          name: `LLDB (${route.id})`,
          observerResumesTarget: false,
          exclusiveModules: true,
        })
    );
    runtime = await SourceDebuggerSessionRuntime.load({
      loaders,
      target,
      createModuleOwnerResolver: (definitions) =>
        createRoutedModuleOwnerResolver(routes, definitions),
    });
    trace("initial component selected");

    assert.deepEqual(
      runtime.components.map(({ id }) => id),
      ["lldb-a"],
      "the second LLDB was instantiated before its module existed"
    );
    await runtime.activate();
    trace("initial component attached");
    assert.deepEqual(
      (await runtime.session.modules()).map(({ owner }) => owner),
      ["lldb-a"]
    );

    await runtime.session.setBreakpoint({
      componentId: "lldb-a",
      target: { kind: "function", name: "compute_factorial" },
    });
    trace("initial breakpoint armed");
    await target.session.evaluate("setTimeout(async () => { await loadB(); runA(); }, 100)");
    const aStop = await continueUntilBreakpoint(runtime.session, "lldb-a", 10, "initial");
    assert.equal(aStop.reason.kind, "breakpoint");
    trace("stopped after late module load");

    const modules = await runtime.session.modules();
    trace("late component attached");
    assert.deepEqual(
      modules.map(({ owner }) => owner),
      ["lldb-a", "lldb-b"]
    );
    assert.deepEqual(
      runtime.components.map(({ id }) => id),
      ["lldb-a", "lldb-b"],
      "the late module did not instantiate and attach its selected owner"
    );
    assert.deepEqual(
      (await runtime.session.components()).map(({ id }) => id),
      ["lldb-a", "lldb-b"]
    );

    await runtime.session.setBreakpoint({
      componentId: "lldb-b",
      target: { kind: "function", name: "compute_factorial" },
    });
    trace("late breakpoint armed");
    await target.session.evaluate("setTimeout(() => runB(), 100)");
    const bStop = await continueUntilBreakpoint(runtime.session, "lldb-a", 10, "late");
    assert.equal(bStop.reason.kind, "breakpoint");
    trace("late component preempted the driver");
    const frames = await runtime.session.frames();
    if (process.env.E2E_RUNTIME_VERBOSE && frames.length === 0) {
      trace(
        `late LLDB backtrace: ${JSON.stringify(await runtime.session.command("thread backtrace", "lldb-b"))}`
      );
      trace(
        `late LLDB images: ${JSON.stringify(await runtime.session.command("image list", "lldb-b"))}`
      );
    }
    assert.equal(frames[0]?.componentId, "lldb-b");
    assert.match(frames[0]?.functionName ?? "", /compute_factorial/);
  } finally {
    trace("cleanup started");
    if (runtime) await runtime.close().catch(() => {});
    else await target?.close().catch(() => {});
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
    trace("cleanup finished");
  }
});

async function continueUntilBreakpoint(session, driverId, maxAttempts = 10, label = "run") {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stop = await session.continue(driverId);
    trace(`${label} continue ${attempt + 1}: ${stop.reason.kind}`);
    if (stop.reason.kind === "breakpoint") return stop;
    if (stop.reason.kind === "none" || stop.reason.kind === "exited") {
      throw new Error(`target ended before reaching a breakpoint: ${stop.reason.kind}`);
    }
  }
  throw new Error(`did not reach a breakpoint after ${maxAttempts} continues`);
}

function trace(message) {
  if (process.env.E2E_RUNTIME_VERBOSE) console.error(`[late-component] ${message}`);
}
