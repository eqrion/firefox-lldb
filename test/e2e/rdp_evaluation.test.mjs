/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { launchFirefox } from "../../src/core/firefox.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { RdpClient, RdpRequestError } from "../../src/rdp/client.ts";
import { encodeRdpFrame, sliceRdpFrame } from "../../src/rdp/transport.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { tracingLogger } from "./harness.mjs";

// Hold one real Firefox packet at the transport boundary. All other traffic
// flows normally, including a result event whose acknowledgement is withheld.
async function evaluationProxy(rdpPort) {
  const sockets = new Set();
  let hold;
  const server = net.createServer((downstream) => {
    const upstream = net.connect(rdpPort, "127.0.0.1");
    sockets.add(downstream).add(upstream);
    downstream.pipe(upstream);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    let buffer = Buffer.alloc(0);
    upstream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = sliceRdpFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        const packet = JSON.parse(frame.body);
        const send = (replacement = packet) => downstream.write(encodeRdpFrame(replacement));
        if (hold?.matches(packet)) {
          const { resolve } = hold;
          hold = undefined;
          resolve({ packet, release: send });
        } else {
          send();
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    holdNext(matches) {
      assert.equal(hold, undefined, "only one packet can be withheld at a time");
      return new Promise((resolve) => {
        hold = { matches, resolve };
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startSession(t) {
  const trace = tracingLogger(80);
  const rdpPort = await freePort();
  const firefox = await launchFirefox({
    rdpPort,
    binary: process.env.FIREFOX_BINARY,
    headless: true,
  });
  let proxy;
  let session;
  t.after(async () => {
    session?.close();
    await proxy?.close();
    await firefox.close();
  });
  await verifyFirefoxLaunchToken(rdpPort, "127.0.0.1", firefox.launchToken);
  proxy = await evaluationProxy(rdpPort);
  session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, trace);
  await session.waitForTopLevelTarget();
  return { session, proxy, trace };
}

const isAcknowledgement = (p) => p.resultID && !p.type;
const evaluationTimeout = /JavaScript evaluation timed out after 5000 ms/;

test(
  "a real request timeout retains its connection, method, queue and age",
  { timeout: 20_000 },
  async (t) => {
    const { proxy, trace } = await startSession(t);
    const client = await RdpClient.connect(proxy.port, "127.0.0.1", {
      logger: trace,
      requestTimeoutMs: 250,
    });
    t.after(() => client.close());
    const held = proxy.holdNext((packet) => Array.isArray(packet.tabs));
    const rejected = assert.rejects(
      client.request("root", { type: "listTabs" }),
      /root\.listTabs timed out/
    );
    await held;
    await rejected;
    const record = trace
      .tail()
      .find((line) => line.includes("[rdp-client] closing") && line.includes("listTabs"));
    assert.ok(record);
    const snapshot = JSON.parse(record.slice(record.indexOf("{")));
    assert.ok(snapshot.connection > 0);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.requests[0].method, "listTabs");
    assert.equal(snapshot.requests[0].queueDepth, 1);
    assert.ok(snapshot.requests[0].ageMs >= 200);
    assert.deepEqual(client.pendingSnapshot().requests, []);
  }
);

test(
  "Firefox request errors preserve typed context without poisoning the FIFO",
  { timeout: 20_000 },
  async (t) => {
    const { proxy, trace } = await startSession(t);
    const client = await RdpClient.connect(proxy.port, "127.0.0.1", { logger: trace });
    t.after(() => client.close());
    await assert.rejects(client.request("root", { type: "firefoxLldbUnknownMethod" }), (error) => {
      assert.ok(error instanceof RdpRequestError);
      assert.equal(error.actor, "root");
      assert.equal(error.method, "firefoxLldbUnknownMethod");
      assert.equal(error.code, "unrecognizedPacketType");
      return true;
    });
    assert.ok(Array.isArray((await client.request("root", { type: "listTabs" })).tabs));
  }
);

test(
  "evaluation deadline covers a withheld Firefox acknowledgement",
  { timeout: 20_000 },
  async (t) => {
    const { session, proxy, trace } = await startSession(t);
    const held = proxy.holdNext(isAcknowledgement);
    const closed = once(session, "close");
    const rejected = assert.rejects(session.evalJS("6 * 7"), evaluationTimeout);
    await held;
    await rejected;
    await closed;
    assert.match(trace.tail().join("\n"), /evaluation-timeout.*awaiting-ack/);
    // The actor FIFO cannot safely be reused without its acknowledgement.
    await assert.rejects(session.evalJS("7 * 7"), /session closed/);
  }
);

test(
  "a late evaluation result does not satisfy the next evaluation",
  { timeout: 20_000 },
  async (t) => {
    const { session, proxy, trace } = await startSession(t);
    const listeners = session.listenerCount("close");
    let closed = false;
    session.once("close", () => {
      closed = true;
    });
    const held = proxy.holdNext((p) => p.type === "evaluationResult");
    const rejected = assert.rejects(session.evalJS("6 * 7"), evaluationTimeout);
    const { release } = await held;
    await rejected;
    assert.equal(closed, false, "an acknowledged evaluation timeout leaves the FIFO usable");
    assert.equal(session.listenerCount("close"), listeners + 1);
    assert.match(trace.tail().join("\n"), /evaluation-timeout.*awaiting-result/);

    const next = session.evalJS("7 * 7");
    release();
    assert.equal((await next).result, 49);
    assert.equal(session.listenerCount("close"), listeners + 1);
  }
);

test(
  "disconnecting before an evaluation acknowledgement rejects without an orphan promise",
  { timeout: 20_000 },
  async (t) => {
    const { session, proxy } = await startSession(t);
    const held = proxy.holdNext(isAcknowledgement);
    const rejected = assert.rejects(
      session.evalJS("6 * 7"),
      /session closed|RDP connection closed/
    );
    await held;
    await proxy.close();
    await rejected;
    // node:test also fails this test on any unhandled rejection from the result wait.
  }
);

test(
  "evaluation acknowledgement errors release their listeners and allow another request",
  { timeout: 20_000 },
  async (t) => {
    const { session, proxy } = await startSession(t);
    const listeners = session.listenerCount("close");
    for (const { reply, error } of [
      { reply: {}, error: /Firefox did not return an evaluation result ID/ },
      {
        reply: { error: "evaluationFailed", message: "injected failure" },
        error: /evaluationFailed: injected failure/,
      },
    ]) {
      const held = proxy.holdNext(isAcknowledgement);
      const rejected = assert.rejects(session.evalJS("6 * 7"), error);
      const { packet, release } = await held;
      release({ from: packet.from, ...reply });
      await rejected;
      assert.equal(session.listenerCount("close"), listeners);
      assert.equal((await session.evalJS("7 * 7")).result, 49);
      assert.equal(session.listenerCount("close"), listeners);
    }
  }
);
