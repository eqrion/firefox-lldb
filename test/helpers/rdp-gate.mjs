/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import { once } from "node:events";
import { EVENTS } from "../../src/rdp/protocol.ts";
import { encodeRdpFrame, sliceRdpFrame } from "../../src/rdp/transport.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Withhold matching real Firefox replies/events, without fabricating protocol
// results. Each proxy connection keeps its own actor FIFO for reply labels.
export async function packetGate(rdpPort, matches, onRequest = () => {}) {
  const held = deferred();
  const withheld = [];
  const sockets = new Set();
  const downstreams = new Set();
  const peers = new Set();
  const eventTypes = new Set(Object.values(EVENTS));
  const server = net.createServer((downstream) => {
    downstreams.add(downstream);
    const upstream = net.connect(rdpPort, "127.0.0.1");
    const closed = deferred();
    peers.add(closed.promise);
    sockets.add(downstream).add(upstream);
    const requests = new Map();
    downstream.on("close", () => {
      upstream.destroy();
      sockets.delete(downstream);
      downstreams.delete(downstream);
      closed.resolve();
    });
    upstream.on("close", () => {
      downstream.destroy();
      sockets.delete(upstream);
    });
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    function packets(socket, receive) {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = sliceRdpFrame(buffer);
          if (!frame) break;
          buffer = frame.rest;
          receive(JSON.parse(frame.body));
        }
      });
    }
    packets(downstream, (packet) => {
      onRequest(packet);
      if (!["resume", "interrupt"].includes(packet.type)) {
        const queue = requests.get(packet.to) ?? [];
        requests.set(packet.to, queue);
        queue.push(packet.type);
      }
      upstream.write(encodeRdpFrame(packet));
    });
    packets(upstream, (packet) => {
      const request = eventTypes.has(packet.type) ? undefined : requests.get(packet.from)?.shift();
      if (matches(packet, request)) {
        withheld.push(() => {
          if (!downstream.destroyed) downstream.write(encodeRdpFrame(packet));
        });
        held.resolve({ packet, request });
      } else downstream.write(encodeRdpFrame(packet));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    held: held.promise,
    injectEvent(packet) {
      for (const downstream of downstreams) downstream.write(encodeRdpFrame(packet));
    },
    release() {
      for (const send of withheld.splice(0)) send();
    },
    peersClosed: () => Promise.all([...peers]),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
