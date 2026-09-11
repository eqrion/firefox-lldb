/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fetchBytes } from "../../src/symbols/fetch.ts";

for (const mode of ["headers", "body", "declared-size", "stream-size", "abort", "success"]) {
  test(
    `symbol fetch bounds ${mode} and releases its HTTP request`,
    { timeout: 5000 },
    async (t) => {
      let arrived, closed;
      const received = new Promise((resolve) => {
        arrived = resolve;
      });
      const disconnected = new Promise((resolve) => {
        closed = resolve;
      });
      const server = http.createServer((request, response) => {
        response.once("close", closed);
        arrived();
        if (mode === "headers") return;
        if (mode === "declared-size") response.setHeader("content-length", 1000);
        response.writeHead(200);
        response.write(new Uint8Array(mode === "stream-size" ? 20 : 4));
        if (mode === "success") response.end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const abort = new AbortController();
      const pending = fetchBytes(`http://127.0.0.1:${server.address().port}/symbols`, {
        maxBytes: 10,
        timeoutMs: 1000,
        signal: abort.signal,
      });
      const outcome =
        mode === "success"
          ? pending
          : assert.rejects(pending, /timed out|too large|cancel symbol read/);
      await received;
      if (mode === "abort") abort.abort(new Error("cancel symbol read"));
      const result = await outcome;
      if (mode === "success") assert.equal(result.length, 4);
      await disconnected;
    }
  );
}
