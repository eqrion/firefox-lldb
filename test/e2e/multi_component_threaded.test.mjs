/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Concurrency proof: two isolated source debuggers share one Firefox session
// which contains the page thread and an emscripten pthread pool. Stops hand off
// from A on a worker, to B on the main thread, and back to A on a reused worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyRepl } from "../../src/mcp/pty-repl.ts";
import { freePort } from "../../src/net/free-port.ts";
import { startStaticServer } from "./harness.mjs";

test("two debugger components coordinate stops across Firefox worker threads", async () => {
  const staticServer = await startStaticServer("test/fixtures/multi-component-threaded");
  const url = `http://127.0.0.1:${staticServer.port}/index.html`;
  let repl;
  try {
    const usedPorts = new Set([staticServer.port]);
    const nextPort = async () => {
      let port = await freePort();
      while (usedPorts.has(port)) port = await freePort();
      usedPorts.add(port);
      return port;
    };
    repl = await PtyRepl.launch({
      url,
      headless: true,
      rdpPort: await nextPort(),
      marionettePort: await nextPort(),
      fire: "runWorkerMainWorkerSequence()",
      components: ["lldb-workers=threaded/matmul.wasm", "lldb-main=two-components/math.wasm"],
      startupTimeoutMs: 120_000,
    });

    const modules = (await repl.send("modules")).output;
    assert.match(modules, /threaded\/matmul\.wasm\s+\[lldb-workers\]/);
    assert.match(modules, /two-components\/math\.wasm.*\[lldb-main\]/);
    assert.match(
      (await repl.send("break lldb-workers::worker_probe_checkpoint")).output,
      /lldb-workers:\d+/
    );
    assert.match((await repl.send("break lldb-main::compute_factorial")).output, /lldb-main:\d+/);

    const workerStop = await repl.send("continue lldb-workers", 60_000);
    assert.equal(workerStop.prompt, true, workerStop.output.slice(-4000));
    assert.match(workerStop.output, /worker_probe_checkpoint/);
    const workerThreads = (await repl.send("threads")).output;
    assert.ok(threadLines(workerThreads).length >= 2, workerThreads);
    assert.ok(stoppedThread(workerThreads) > 1, workerThreads);
    assert.match((await repl.send("bt")).output, /worker_probe_checkpoint.*\[lldb-workers\]/);

    await continueUntil(repl, "lldb-main", /compute_factorial/);
    const mainThreads = (await repl.send("threads")).output;
    assert.equal(stoppedThread(mainThreads), 1, mainThreads);
    assert.match((await repl.send("bt")).output, /compute_factorial.*\[lldb-main\]/);
    const workerStatus = (await repl.send("lldb lldb-workers::process status")).output;
    assert.doesNotMatch(workerStatus, /exited|must be launched/i, workerStatus);

    await continueUntil(repl, "lldb-workers", /worker_probe_checkpoint/);
    const secondWorkerThreads = (await repl.send("threads")).output;
    assert.ok(stoppedThread(secondWorkerThreads) > 1, secondWorkerThreads);
  } finally {
    await repl?.shutdown().catch(() => {});
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
});

function threadLines(output) {
  return output.split("\n").filter((line) => /^[ *]\s+\d+\b/.test(line));
}

function stoppedThread(output) {
  const match = output.match(/^\*\s+(\d+)\b/m);
  assert.ok(match, output);
  return Number(match[1]);
}

async function continueUntil(repl, componentId, expected) {
  const stops = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const stop = await repl.send(`continue ${componentId}`, 60_000);
    if (!stop.prompt) {
      const lines = stop.output.split("\n");
      const sessionLines = lines.filter((line) => /\[session\]/.test(line)).slice(-50);
      const driverLines = lines.filter((line) => /\[lldb-main\]/.test(line)).slice(-30);
      const observerLines = lines
        .filter((line) => /\[lldb-workers\]/.test(line) && !/ armed /.test(line))
        .slice(-30);
      const coordination = [...sessionLines, ...driverLines, ...observerLines];
      assert.fail(
        coordination.length ? coordination.slice(-80).join("\n") : stop.output.slice(-4000)
      );
    }
    stops.push(stop.output);
    if (expected.test(stop.output)) return stop;
    assert.doesNotMatch(stop.output, /Process \d+ exited/);
  }
  assert.fail(`did not reach ${expected} after stops:\n${stops.join("\n---\n")}`);
}
