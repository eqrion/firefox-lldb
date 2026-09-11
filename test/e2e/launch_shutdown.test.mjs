/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { launchFirefox, FirefoxPortInUseError } from "../../src/core/firefox.ts";
import { LLDBClient } from "lldb-wasm";
import { EmbeddedLldbBridge } from "../../src/lldb/bridge.ts";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { platformConnect, startStaticServer, tracingLogger } from "./harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("an occupied RDP port rejects before Firefox starts and receives no probe traffic", async (t) => {
  let connections = 0;
  const listener = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const records = [];
  await assert.rejects(
    launchFirefox({
      rdpPort: listener.address().port,
      headless: true,
      binary: process.env.FIREFOX_BINARY,
      logger: { debug: (message) => records.push(message), info() {}, warn() {}, error() {} },
    }),
    FirefoxPortInUseError
  );
  assert.equal(connections, 0);
  assert.equal(
    records.some((line) => line.includes("launch.spawned")),
    false
  );
});

test(
  "shutdown prevents an attach from advancing past its cancelled target boundary",
  {
    timeout: 60_000,
  },
  async (t) => {
    const entered = deferred();
    const release = deferred();
    const stopping = deferred();
    const trace = tracingLogger(200);
    const records = [];
    const logger = {
      ...trace,
      debug(message) {
        records.push(message);
        trace.debug(message);
        if (message.includes("[spawner] stop.requested")) stopping.resolve();
      },
    };
    let client, bridge, handle, staticServer;
    t.after(async () => {
      release.resolve();
      try {
        const results = await Promise.allSettled([
          bridge?.close(),
          handle?.shutdown(),
          client?.destroy(),
        ]);
        const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
        if (errors.length) throw new AggregateError(errors, `cleanup failed; ${trace.logPath}`);
      } finally {
        if (staticServer) {
          staticServer.server.closeAllConnections();
          await new Promise((resolve) => staticServer.server.close(resolve));
        }
        trace.close();
      }
    });
    staticServer = await startStaticServer("test/fixtures/simple");
    client = await LLDBClient.create({ logger: trace });
    bridge = new EmbeddedLldbBridge(client, trace);
    const args = parseCliArgs([
      "--launch",
      "--headless",
      "--port",
      "0",
      "--rdp-port",
      String(await freePort()),
      ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
      "--url",
      `http://127.0.0.1:${staticServer.port}/index.html`,
    ]);
    handle = await startPlatformServer(args, {
      logger,
      wrapConnectPort: (port) => {
        assert.fail(`shutdown must not advertise the late GDB server on ${port}`);
      },
      onRdpSession(session) {
        const waitForTarget = session.waitForTopLevelTarget.bind(session);
        session.waitForTopLevelTarget = async (...args) => {
          await waitForTarget(...args);
          entered.resolve();
          // Deliberately ignore cancellation here to exercise a late continuation.
          // The launcher must check cancellation before acquiring anything else.
          await release.promise;
        };
      },
    });
    await platformConnect(client, await bridge.bridgeTcp(handle.port, "platform"), trace);
    const attach = client.sessionCommand("process attach --plugin wasm --pid 1");
    // Observe rejection immediately even if setup fails before reaching the gate.
    const outcome = attach.then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    await entered.promise;
    let closed = false;
    const shutdown = handle.shutdown().then(() => {
      closed = true;
    });
    const shutdownOutcome = shutdown.then(
      () => ({}),
      (error) => ({ error })
    );
    await stopping.promise;
    assert.equal(closed, false, "shutdown must join the pending launcher");
    assert.deepEqual(handle.spawner.list(), [], "pending launch is not a live server");
    release.resolve();
    const cleanup = await shutdownOutcome;
    assert.ifError(cleanup.error);
    // LLDB currently waits about 40 seconds for this failed launch command,
    // even though the transport and owned browser resources are already closed.
    // Keep that upstream timeout visible rather than treating it as cancellation.
    const attached = await outcome;
    assert.ok(attached.error || attached.result.status >= 6, "attach must not succeed after close");
    assert.deepEqual(handle.spawner.list(), []);
    await assert.rejects(handle.spawner.launch(), /spawner is closed/);
    const transcript = records.join("\n");
    assert.match(transcript, /\[spawner\] stop.completed/);
    assert.doesNotMatch(transcript, /\[spawner\] launch.ready/);
    assert.match(transcript, /\[firefox\] cleanup.verified/);
    const completed = transcript.indexOf("[spawner] stop.completed");
    assert.ok(completed < transcript.indexOf("[firefox] cleanup.verified"));
    assert.match(transcript, /\[launch\] cancel stage=initial-target/);
    assert.doesNotMatch(transcript, /\[component\] Debugger listening|\[launch\] stage=navigation/);
  }
);
