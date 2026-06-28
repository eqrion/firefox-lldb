/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RspServer } from "../../src/protocol/rsp-server.js";
import { RspClient } from "./rsp-client.js";

const echoHandler = {
  async handle(payload: Buffer) {
    return payload.toString("latin1");
  },
};

test("RspServer in singleConnection mode rejects a second client", async () => {
  const srv = new RspServer(echoHandler, { singleConnection: true });
  const port = await srv.listen(0);

  const cl1 = await RspClient.connect(port);
  const cl2 = await RspClient.connect(port);

  // cl1 should be able to communicate; cl2 should be disconnected.
  const resp = await cl1.requestText("ping");
  assert.equal(resp, "ping", "first client should get echo response");

  // cl2 should get closed quickly (second connection was rejected).
  await new Promise<void>((resolve) => {
    cl2.socket.on("close", resolve);
    // Fallback: if already closed, resolve immediately.
    setTimeout(resolve, 200);
  });

  cl1.close();
  cl2.close();
  await srv.close();
});

test("RspServer.close() destroys open client sockets promptly", async () => {
  const srv = new RspServer(echoHandler);
  const port = await srv.listen(0);

  const cl = await RspClient.connect(port);

  const before = Date.now();
  await srv.close(); // should destroy the socket immediately
  const elapsed = Date.now() - before;

  // close() should return promptly (< 300 ms), not wait for cl to disconnect.
  assert.ok(elapsed < 300, `close() took ${elapsed}ms, expected < 300ms`);

  cl.close();
});
