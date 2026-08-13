/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Two genuinely different source debugger implementations share one Firefox
// target: wasm LLDB consumes a filtered GDB RSP projection for DWARF, while the
// generated-text component imports the direct Wasm debuggee capability.

import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { FirefoxSourceDebuggerTarget } from "../../src/source-debugger/firefox-target.ts";
import {
  LldbSourceDebuggerComponentLoader,
  LldbSourceDebuggerTarget,
} from "../../src/source-debugger/lldb-loader.ts";
import { SourceDebuggerSessionRuntime } from "../../src/source-debugger/runtime.ts";
import {
  WASM_SOURCE_DEBUGGER_ID,
  WasmSourceDebuggerComponentLoader,
} from "../../src/source-debugger/wasm-source-component.ts";
import { startStaticServer } from "./harness.mjs";

test("LLDB and generated Wasm text coordinate one mixed source session", async () => {
  const staticServer = await startStaticServer("test/fixtures/two-components");
  let target;
  let runtime;
  try {
    const args = parseCliArgs([
      "--launch",
      "--headless",
      "--port",
      "0",
      "--rdp-port",
      String(await freePort()),
      "--url",
      `http://127.0.0.1:${staticServer.port}/mixed-wat.html`,
    ]);
    target = await FirefoxSourceDebuggerTarget.start({ args });
    await waitForModules(target, 2);

    const route = { id: "lldb", urlSubstring: "*" };
    const lldbTarget = new LldbSourceDebuggerTarget({
      target,
      routes: [route],
      ownershipFilteredModules: true,
    });
    runtime = await SourceDebuggerSessionRuntime.load({
      loaders: [
        new LldbSourceDebuggerComponentLoader(lldbTarget, route, {
          observerResumesTarget: false,
          exclusiveModules: true,
        }),
        new WasmSourceDebuggerComponentLoader(),
      ],
      target,
      getRdpSession: () => target.session,
    });

    assert.deepEqual(
      runtime.components.map(({ id }) => id),
      ["lldb", WASM_SOURCE_DEBUGGER_ID]
    );
    await runtime.activate();
    const modules = await runtime.session.modules();
    assert.equal(modules.find(({ url }) => url.includes("math.wasm"))?.owner, "lldb");
    assert.equal(
      modules.find(({ url }) => url.includes("plain.wasm"))?.owner,
      WASM_SOURCE_DEBUGGER_ID
    );

    const wasmComponent = runtime.components.find(
      ({ id }) => id === WASM_SOURCE_DEBUGGER_ID
    ).component;
    const [watSource] = await wasmComponent.sources();
    assert.match(watSource.url, /^wasm-text:\/\/.+\/module\.wat$/);
    assert.match(watSource.content, /\(func \$wat_factorial/);
    assert.match(watSource.content, /;; @0x[0-9a-f]+/);

    const functionBreakpoint = await runtime.session.setBreakpoint({
      componentId: WASM_SOURCE_DEBUGGER_ID,
      target: { kind: "function", name: "wat_factorial" },
    });
    assert.equal(functionBreakpoint.verified, true, functionBreakpoint.message);
    await runtime.session.removeBreakpoint(functionBreakpoint.id);
    const multiplyLine =
      watSource.content.split("\n").findIndex((line) => /\bi32\.mul\b/.test(line)) + 1;
    assert.ok(multiplyLine > 0, "the generated source omitted i32.mul");
    const watBreakpoint = await runtime.session.setBreakpoint({
      componentId: WASM_SOURCE_DEBUGGER_ID,
      target: {
        kind: "source",
        location: { sourceId: watSource.id, line: multiplyLine },
      },
    });
    assert.equal(
      watBreakpoint.verified,
      true,
      `${watBreakpoint.message ?? "unverified breakpoint"}\n${watSource.content}`
    );

    // LLDB owns the run lease, but the direct component's breakpoint wins and
    // aborts LLDB's source plan through the normal session preemption path.
    await target.session.evaluate("debuggersReady.then(() => setTimeout(() => runMixed(), 100))");
    const watStop = await runtime.session.continue("lldb");
    assert.equal(watStop.reason.kind, "breakpoint");
    const mixedFrames = await runtime.session.frames();
    assert.equal(mixedFrames[0]?.componentId, WASM_SOURCE_DEBUGGER_ID);
    assert.equal(mixedFrames[0]?.functionName, "wat_factorial");
    const dwarfCaller = mixedFrames.find(
      (frame) => frame.componentId === "lldb" && /call_other_factorial/.test(frame.functionName)
    );
    assert.ok(dwarfCaller, "the LLDB-owned caller was missing from the composed stack");
    assert.ok(
      dwarfCaller.physicalFrameIndex > mixedFrames[0].physicalFrameIndex,
      "the mixed stack was not ordered by physical frame position"
    );
    const watScopes = await runtime.session.scopes(mixedFrames[0].id);
    assert.match(
      watScopes[0].values.map(({ name }) => name).join(" "),
      /\$local0/,
      "the direct component did not expose raw Wasm locals"
    );

    await runtime.session.removeBreakpoint(watBreakpoint.id);
    const stepped = await runtime.session.stepInto(mixedFrames[0].id);
    assert.equal(stepped.reason.kind, "step");
    assert.equal((await runtime.session.frames())[0]?.componentId, WASM_SOURCE_DEBUGGER_ID);
    const lldbBreakpoint = await runtime.session.setBreakpoint({
      componentId: "lldb",
      target: { kind: "function", name: "compute_factorial" },
    });
    assert.equal(lldbBreakpoint.verified, true, lldbBreakpoint.message);

    // Reverse the driver/observer roles. The direct component performs the
    // physical continue and LLDB's real source breakpoint preempts it.
    await target.session.evaluate("setTimeout(() => runDwarf(), 100)");
    const lldbStop = await runtime.session.continue(WASM_SOURCE_DEBUGGER_ID);
    assert.equal(lldbStop.reason.kind, "breakpoint");
    const lldbFrames = await runtime.session.frames();
    assert.equal(lldbFrames[0]?.componentId, "lldb");
    assert.match(lldbFrames[0]?.functionName ?? "", /compute_factorial/);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    else await target?.close().catch(() => {});
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
});

async function waitForModules(target, count) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const modules = await target.modules();
    if (modules.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected ${count} Wasm modules before component discovery`);
}
