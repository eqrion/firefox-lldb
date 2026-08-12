/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Production-path proof: spawn the real firefox-lldb executable in a PTY and
// ask it to construct isolated LLDB SourceDebuggerComponents itself. Every
// generic operation crosses the outer worker's MessagePort RPC boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyRepl } from "../../src/mcp/pty-repl.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { startStaticServer } from "./harness.mjs";

test("the CLI coordinates three routed SourceDebuggerComponents", async () => {
  const staticServer = await startStaticServer("test/fixtures/two-components");
  const url = `http://127.0.0.1:${staticServer.port}/index.html`;
  let repl;
  try {
    const rdpPort = await freePort();
    let marionettePort = await freePort();
    while (marionettePort === rdpPort) marionettePort = await freePort();
    let platformPort = await freePort();
    while (platformPort === rdpPort || platformPort === marionettePort) {
      platformPort = await freePort();
    }
    repl = await PtyRepl.launch({
      url,
      headless: true,
      platformPort,
      rdpPort,
      marionettePort,
      fire: "runA()",
      // C deliberately owns no module. It proves that a passive third
      // observer also converges when B preempts A's active source plan.
      components: ["lldb-a=component=a", "lldb-b=component=b", "lldb-c=component=c"],
      startupTimeoutMs: 120_000,
    });

    const components = await repl.send("components");
    assert.equal(components.prompt, true);
    assert.match(
      components.output,
      /lldb-a\s+LLDB \(lldb-a\).*lldb-b\s+LLDB \(lldb-b\).*lldb-c\s+LLDB \(lldb-c\)/s
    );

    const modules = await repl.send("modules");
    assert.match(modules.output, /component=a\s+\[lldb-a\]/);
    assert.match(modules.output, /component=b\s+\[lldb-b\]/);
    assert.doesNotMatch(modules.output, /\[lldb-c\]/);
    assert.match((await repl.send("break lldb-a::compute_factorial")).output, /lldb-a:1/);
    assert.match((await repl.send("break lldb-a::call_other_factorial")).output, /lldb-a:2/);

    const first = await repl.send("continue lldb-a", 60_000);
    assert.equal(first.prompt, true);
    assert.match(first.output, /compute_factorial/);

    await repl.send("js p setTimeout(() => runInterleaved(), 100)");
    const caller = await repl.send("continue lldb-a", 60_000);
    assert.equal(caller.prompt, true);
    assert.match(caller.output, /call_other_factorial/);

    // One source-level step from A crosses the JavaScript import and hands
    // control to the debugger which owns B's newly-entered Wasm activation.
    const second = await repl.send("step", 60_000);
    assert.equal(second.prompt, true, second.output.slice(-4000));
    const stepBacktrace = await repl.send("bt");
    assert.match(stepBacktrace.output, /compute_factorial/);
    assert.match(
      stepBacktrace.output,
      /#0 .*compute_factorial.*\[lldb-b\].*#1 .*call_other_factorial.*\[lldb-a\]/s
    );

    await repl.send("frame 0");
    assert.match((await repl.send("locals")).output, /\bn\s*=\s*6\b/);
    await repl.send("frame 1");
    assert.match((await repl.send("locals")).output, /\bn\s*=\s*7\b/);
    await repl.send("frame 0");
    const finish = await repl.send("finish", 60_000);
    assert.equal(finish.prompt, true);
    assert.match(finish.output, /stop reason = (?:wasm )?step/);
    assert.doesNotMatch((await repl.send("bt")).output, /\[lldb-b\]/);

    // Step-over keeps the foreign B activation hidden and returns to A's next
    // source line after the cross-language call has produced its result.
    assert.match((await repl.send("break lldb-a::call_other_then_adjust")).output, /lldb-a:\d+/);
    await repl.send("js p setTimeout(() => runStepOver(), 100)");
    const stepOverCaller = await repl.send("continue lldb-a", 60_000);
    assert.match(stepOverCaller.output, /call_other_then_adjust/);
    const next = await repl.send("next", 60_000);
    assert.equal(next.prompt, true);
    const nextBacktrace = await repl.send("bt");
    assert.match(nextBacktrace.output, /#0 .*call_other_then_adjust.*\[lldb-a\]/);
    assert.doesNotMatch(nextBacktrace.output, /\[lldb-b\]/);
    assert.match((await repl.send("locals")).output, /\bresult\s*=\s*720\b/);

    // The same step-over must not suppress a real source breakpoint owned by
    // the otherwise-foreign component.
    assert.match((await repl.send("break lldb-b::compute_factorial")).output, /lldb-b:\d+/);
    await repl.send("js p setTimeout(() => runStepOver(), 100)");
    assert.match((await repl.send("continue lldb-a", 60_000)).output, /call_other_then_adjust/);
    const preempted = await repl.send("next", 60_000);
    assert.equal(preempted.prompt, true, preempted.output.slice(-4000));
    const preemptedBacktrace = await repl.send("bt");
    assert.match(
      preemptedBacktrace.output,
      /#0 .*compute_factorial.*\[lldb-b\].*#1 .*call_other_then_adjust.*\[lldb-a\]/s
    );
  } finally {
    await repl?.shutdown().catch(() => {});
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
});
