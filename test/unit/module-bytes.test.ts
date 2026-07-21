/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpModuleByteProvider, isWasmBinary } from "../../src/rdp/module-bytes.js";

const WASM = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

async function serve(
  handler: http.RequestListener
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/module.wasm`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("HttpModuleByteProvider accepts a successful wasm response", async () => {
  const server = await serve((_req, res) => res.end(WASM));
  try {
    const bytes = await new HttpModuleByteProvider().fetch(server.url);
    assert.equal(isWasmBinary(bytes), true);
  } finally {
    await server.close();
  }
});

test("HttpModuleByteProvider rejects HTTP errors and non-wasm bodies", async () => {
  const notFound = await serve((_req, res) => {
    res.statusCode = 404;
    res.end("missing");
  });
  try {
    await assert.rejects(new HttpModuleByteProvider().fetch(notFound.url), /HTTP 404/);
  } finally {
    await notFound.close();
  }

  const html = await serve((_req, res) => res.end("<!doctype html>login"));
  try {
    await assert.rejects(new HttpModuleByteProvider().fetch(html.url), /not a WebAssembly/);
  } finally {
    await html.close();
  }
});
