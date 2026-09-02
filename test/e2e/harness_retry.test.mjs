/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { bridgeTcp, retrySessionSetup, tracingLogger, withDeadline } from "./harness.mjs";

test("session setup retries with a fresh attempt after transient failures", async () => {
  let attempts = 0;
  const session = await retrySessionSetup(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error(`transient failure ${attempts}`);
      return { attempt: attempts };
    },
    3,
    { quiet: true }
  );

  assert.deepEqual(session, { attempt: 3 });
});

test("session setup reports every failure after exhausting retries", async () => {
  await assert.rejects(
    retrySessionSetup(
      async () => {
        throw new Error("still wedged");
      },
      2,
      { quiet: true }
    ),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.message, "session setup failed after 2 attempts");
      assert.equal(err.errors.length, 2);
      return true;
    }
  );
});

test("bridge diagnostics retain channel state and byte flow", async (t) => {
  let peer;
  let resolveTcpReceived;
  const tcpReceived = new Promise((resolve) => {
    resolveTcpReceived = resolve;
  });
  const server = net.createServer((socket) => {
    peer = socket;
    socket.on("data", (data) => resolveTcpReceived(data));
    // Write the response in pieces; TCP is allowed to coalesce them.
    socket.write("+$E");
    socket.write("79#b5");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const sockets = new Set();
  t.after(async () => {
    peer?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  let sendFromLldb;
  let resolveLldbReceived;
  const lldbReceived = new Promise((resolve) => {
    resolveLldbReceived = resolve;
  });
  const client = {
    createChannel: async () => 7,
    bridgeChannel: async (_channelId, onData) => {
      sendFromLldb = onData;
    },
    channelServerWrite: async (_channelId, data) => {
      resolveLldbReceived(Buffer.from(data));
      return data.length;
    },
  };
  const trace = tracingLogger();
  const port = server.address().port;
  const channelId = await bridgeTcp(client, sockets, port, { trace, label: "platform" });
  assert.equal(channelId, 7);

  await lldbReceived;
  sendFromLldb(new TextEncoder().encode("$m40000001000001a1,400#65"));
  await tcpReceived;
  await new Promise((resolve) => setImmediate(resolve));

  const tail = trace.tail().join("\n");
  assert.match(tail, /\[bridge platform\] first TCP->LLDB data/);
  assert.match(tail, /\[bridge platform\] first LLDB->TCP data \(25 bytes\)/);
  assert.match(
    tail,
    /\[state\] bridge platform: channel=7 tcp=connected LLDB->TCP=1 chunks\/25 bytes TCP->LLDB=\d+ chunks\/8 bytes LLDB-writes=\d+ completed\/8 bytes-accepted\/0 pending/
  );
  assert.match(tail, /\[state\] rsp platform LLDB->TCP: \$m40000001000001a1,400#65/);
  assert.match(tail, /\[state\] rsp platform TCP->LLDB: \$E79#b5/);
});

test("deadline diagnostics report the active stage and cleanup outcome", async () => {
  const trace = tracingLogger();
  trace.stage("submitting process attach attempt 1/4");
  trace.state("bridge tab-1", "channel=2 tcp=connected LLDB->TCP=0 chunks/0 bytes");
  const session = {
    forceKillFirefox() {},
    shutdown: async () => {},
  };

  await assert.rejects(withDeadline(session, new Promise(() => {}), 5, trace), (err) => {
    assert.match(err.message, /\[state\] setup: submitting process attach attempt 1\/4/);
    assert.match(err.message, /\[state\] bridge tab-1: channel=2 tcp=connected/);
    assert.match(err.message, /cleanup: session shutdown completed/);
    return true;
  });
});
