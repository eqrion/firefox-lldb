/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unit tests for RdpClient connection-close behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RdpClient } from "../../src/rdp/client.js";

function startFakeRdpServer(
  handler?: (data: Buffer, socket: net.Socket) => void
): Promise<{ port: number; close: () => void; socket: () => net.Socket | null }> {
  let connSocket: net.Socket | null = null;
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      connSocket = sock;
      // Send the root greeting to unblock RdpClient.connect().
      const greeting = JSON.stringify({ from: "root" });
      sock.write(`${greeting.length}:${greeting}`);
      if (handler) sock.on("data", (d) => handler(d, sock));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => { connSocket?.destroy(); srv.close(); },
        socket: () => connSocket,
      });
    });
  });
}

test("pending request() rejects when connection closes before reply", async () => {
  const srv = await startFakeRdpServer();
  const client = await RdpClient.connect(srv.port);
  // Suppress the ECONNRESET that fires before the close event.
  client.on("error", () => {});

  // Fire a request that the server won't answer.
  const pending = client.request("someActor", { type: "doSomething" });

  // Close the server-side socket abruptly.
  srv.socket()?.destroy();

  await assert.rejects(pending, /closed/i, "pending request should reject on close");

  client.close();
  srv.close();
});
