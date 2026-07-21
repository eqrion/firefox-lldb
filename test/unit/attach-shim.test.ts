/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startAttachShim } from "../../src/protocol/attach-shim.js";
import { framePacket } from "../../src/protocol/packet.js";

function checksum(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) & 0xff;
  return sum;
}

// Collect all bytes received on a socket until it closes.
function collectBytes(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

// Start a fake gdbstub component TCP server that accepts one connection.
function startFakeComponent(): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((conn) => {
      // Immediately close after accepting — simulates a component exiting.
      conn.destroy();
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => srv.close() });
    });
  });
}

test("shim injects W00 when component closes after vAttach", async () => {
  // Component that answers QStartNoAckMode and qProcessInfo (pre-attach), then
  // destroys the connection once vAttach arrives.
  const compServer = await new Promise<{ port: number; close(): void }>((resolve) => {
    const srv = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        // Parse complete RSP packets from buf.
        for (;;) {
          if (buf.length === 0) break;
          if (buf[0] === 0x2b || buf[0] === 0x2d) {
            buf = buf.subarray(1);
            continue;
          }
          if (buf[0] !== 0x24) {
            buf = buf.subarray(1);
            continue;
          }
          const hash = buf.indexOf(0x23);
          if (hash === -1 || buf.length < hash + 3) break;
          const payload = buf.toString("latin1", 1, hash);
          buf = buf.subarray(hash + 3);
          if (payload.startsWith("QStartNoAckMode")) {
            conn.write(`+$OK#9a`);
          } else if (payload.startsWith("vAttach")) {
            // Send a well-formed stop reply then close.
            const stop = "T05thread:1;";
            conn.write(
              Buffer.from(`$${stop}#${checksum(stop).toString(16).padStart(2, "0")}`, "latin1")
            );
            conn.destroy();
          }
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => srv.close() });
    });
  });

  const shim = await startAttachShim({ listenPort: 0, componentPort: compServer.port });

  // Connect as LLDB would.
  const lldb = net.createConnection({ port: shim.port, host: "127.0.0.1" });
  const received = collectBytes(lldb);

  // Drive the pre-attach sequence.
  await new Promise<void>((r) => setTimeout(r, 20));
  lldb.write(framePacket("QStartNoAckMode"));
  await new Promise<void>((r) => setTimeout(r, 20));
  lldb.write(framePacket("vAttach;1"));
  // Wait for the component to close (and for the shim to inject W00).
  const data = await received;
  const text = data.toString("latin1");

  // The shim should have injected $W00#b7 before ending the connection.
  assert.ok(text.includes("$W00#b7"), `expected W00 packet in: ${JSON.stringify(text)}`);

  await shim.close();
  compServer.close();
});

test("shim does NOT inject W00 when component closes before vAttach", async () => {
  // Component that closes immediately without vAttach.
  const compServer = await startFakeComponent();
  const shim = await startAttachShim({ listenPort: 0, componentPort: compServer.port });

  const lldb = net.createConnection({ port: shim.port, host: "127.0.0.1" });
  const received = collectBytes(lldb);
  await received;

  const text = (await received.catch(() => Buffer.alloc(0))).toString("latin1");
  assert.ok(!text.includes("W00"), `unexpected W00 in pre-attach close: ${JSON.stringify(text)}`);

  await shim.close();
  compServer.close();
});

test("shim rejects vAttach for a PID the platform did not advertise", async () => {
  let upstream = "";
  const compServer = await new Promise<{ port: number; close(): void }>((resolve) => {
    const srv = net.createServer((conn) => {
      conn.on("data", (data) => (upstream += data.toString("latin1")));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({ port, close: () => srv.close() });
    });
  });
  const shim = await startAttachShim({
    listenPort: 0,
    componentPort: compServer.port,
    isValidPid: (pid) => pid === 1,
  });
  const lldb = net.createConnection({ port: shim.port, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    lldb.once("connect", resolve);
    lldb.once("error", reject);
  });

  const rejected = new Promise<Buffer>((resolve) => lldb.once("data", resolve));
  lldb.write(framePacket("vAttach;3e7"));
  const reply = (await rejected).toString("latin1");
  assert.match(reply, /\$E01#/);

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch(upstream, /vAttach/, "invalid attach must not reach the component");

  lldb.destroy();
  await shim.close();
  compServer.close();
});
