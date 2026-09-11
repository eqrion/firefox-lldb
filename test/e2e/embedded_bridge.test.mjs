/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { LLDBClient } from "lldb-wasm";
import { EmbeddedLldbBridge } from "../../src/lldb/bridge.ts";
import { PacketParser } from "../../src/protocol/packet.ts";
import { tracingLogger } from "./harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function listen(t, handler) {
  const peers = new Set();
  const server = net.createServer((peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    handler(peer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test(
  "TCP disconnect closes the real LLDB channel and the command reports failure",
  { timeout: 15_000 },
  async (t) => {
    const received = deferred();
    const port = await listen(t, (peer) => {
      const parser = new PacketParser();
      peer.on("data", (data) => {
        for (const packet of parser.feed(data)) {
          if (packet.type === "packet" && packet.payload.toString() === "QStartNoAckMode")
            received.resolve(peer);
        }
      });
    });
    const trace = tracingLogger(80);
    const client = await LLDBClient.create({ logger: trace });
    const bridge = new EmbeddedLldbBridge(client, trace);
    t.after(async () => {
      await bridge.close();
      await client.destroy();
      trace.close();
    });
    const channel = await bridge.bridgeTcp(port, "platform");
    await client.sessionCommand("platform select remote-gdb-server");
    const command = client.sessionCommand(`platform connect inprocess://${channel}`);
    const peer = await received.promise;
    peer.destroy();
    const result = await command;
    assert.ok(result.status >= 6, JSON.stringify(result));
    await bridge.close();
    const tail = trace.tail().join("\n");
    assert.match(tail, /\[bridge platform\] TCP closed/);
    assert.match(tail, /channel.closed/);
    assert.match(tail, /last LLDB->TCP RSP \$QStartNoAckMode/);
    // Upstream's initial handshake still takes its six-second timeout even
    // when the channel has been destroyed. Do not claim immediate cancellation.
    await assert.rejects(client.channelServerWrite(channel, Uint8Array.of(1)), /not found/);
  }
);

test("closing during channel creation owns the late channel", async () => {
  const created = deferred();
  const destroyed = [];
  const trace = tracingLogger();
  const bridge = new EmbeddedLldbBridge(
    {
      createChannel: () => created.promise,
      bridgeChannel: async () => assert.fail("must not register after close"),
      channelServerWrite: async () => assert.fail("must not write after close"),
      destroyChannel: async (id) => {
        destroyed.push(id);
      },
    },
    trace
  );
  const rejected = assert.rejects(bridge.bridgeTcp(1), /closed during channel creation/);
  const closed = bridge.close();
  assert.equal(bridge.close(), closed, "shutdown is idempotent");
  created.resolve(7);
  await Promise.all([closed, rejected]);
  assert.deepEqual(destroyed, [7]);
  await assert.rejects(bridge.bridgeTcp(1), /bridge is closed/);
  trace.close();
});

test("bridge cleanup times out without relinquishing a late channel", async () => {
  const created = deferred();
  const destroyed = deferred();
  const trace = tracingLogger();
  const bridge = new EmbeddedLldbBridge(
    {
      createChannel: () => created.promise,
      bridgeChannel: async () => assert.fail("must not register after close"),
      channelServerWrite: async () => assert.fail("must not write after close"),
      destroyChannel: async (id) => destroyed.resolve(id),
    },
    trace
  );
  const rejected = assert.rejects(bridge.bridgeTcp(1), /closed during channel creation/);
  await assert.rejects(bridge.close(5), /cleanup timed out.*destroy LLDBClient/);
  created.resolve(9);
  await rejected;
  assert.equal(await destroyed.promise, 9);
  trace.close();
});

test(
  "closing during drain registration waits before destroying the channel",
  { timeout: 10_000 },
  async (t) => {
    const registering = deferred();
    const registered = deferred();
    const destroyed = [];
    const port = await listen(t, () => {});
    const trace = tracingLogger();
    const bridge = new EmbeddedLldbBridge(
      {
        createChannel: async () => 7,
        bridgeChannel: async () => {
          registering.resolve();
          await registered.promise;
        },
        channelServerWrite: async (_id, data) => data.length,
        destroyChannel: async (id) => {
          destroyed.push(id);
        },
      },
      trace
    );
    const rejected = assert.rejects(bridge.bridgeTcp(port), /closed during .*setup/);
    await registering.promise;
    const closing = bridge.close();
    assert.deepEqual(destroyed, []);
    registered.resolve();
    await Promise.all([closing, rejected]);
    assert.deepEqual(destroyed, [7]);
    trace.close();
  }
);

test(
  "partial channel writes close both ends and preserve diagnostic state",
  { timeout: 10_000 },
  async (t) => {
    const wrote = deferred();
    const accepted = deferred();
    const peerClosed = deferred();
    const destroyed = [];
    const port = await listen(t, (peer) => {
      peer.once("close", () => peerClosed.resolve());
      peer.write("+$E79#b5");
    });
    const trace = tracingLogger();
    const bridge = new EmbeddedLldbBridge(
      {
        createChannel: async () => 7,
        bridgeChannel: async () => {},
        channelServerWrite: async () => {
          wrote.resolve();
          return accepted.promise;
        },
        destroyChannel: async (id) => {
          destroyed.push(id);
        },
      },
      trace
    );
    t.after(async () => {
      await bridge.close();
      trace.close();
    });
    await bridge.bridgeTcp(port, "platform");
    await wrote.promise;
    assert.deepEqual(destroyed, [], "an outstanding write still owns the channel");
    accepted.resolve(2);
    await peerClosed.promise;
    await bridge.close();
    assert.deepEqual(destroyed, [7]);
    assert.match(trace.tail().join("\n"), /partial write: accepted 2\/8 bytes/);
    assert.match(bridge.failure, /partial write: accepted 2\/8 bytes/);
    assert.match((await bridge.failed).message, /partial write: accepted 2\/8 bytes/);
    assert.match(trace.tail().join("\n"), /last TCP->LLDB RSP \$E79#b5/);
  }
);
