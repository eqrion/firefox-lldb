/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Drives the firefox-lldb MCP server (src/mcp/server.ts) over stdio with the
// MCP SDK client, exactly as a coding agent would. This exercises the full
// agent path: a pty-spawned real CLI behind the lldb_* tools, against headless
// Firefox. Asserts the REPL output that comes back through the tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURES, startStaticServer } from "./harness.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: REPO,
    env: process.env,
    stderr: "ignore",
  });
  const client = new Client({ name: "mcp-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const send = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).map((c) => c.text ?? "").join("");
};

async function withSession(fxName, fn) {
  const fx = FIXTURES[fxName];
  const staticServer = await startStaticServer(fx.pageDir);
  const url = `http://127.0.0.1:${staticServer.port}/index.html`;
  const client = await connect();
  try {
    const banner = await send(client, "lldb_launch", { url, headless: true, fire: fx.fire });
    assert.match(banner, /marionette-port \d+/, `launch banner: ${banner}`);
    await fn(client, fx);
  } finally {
    await send(client, "lldb_shutdown").catch(() => {});
    await client.close().catch(() => {});
    await new Promise((r) => staticServer.server.close(r));
  }
}

test("MCP: launch, set a breakpoint, continue, hit it", async () => {
  await withSession("factorial", async (client, fx) => {
    const bp = await send(client, "lldb_send", { command: `breakpoint set -n ${fx.breakFunc}` });
    assert.match(bp, /Breakpoint 1/, `breakpoint set output: ${bp}`);

    const cont = await send(client, "lldb_send", { command: "continue", timeoutMs: 60000 });
    assert.match(cont, new RegExp(fx.breakFunc), `continue/stop output: ${cont}`);

    const frame = await send(client, "lldb_send", { command: "frame variable" });
    assert.ok(frame.length > 0, "frame variable returned output");
  });
});

test("MCP: thread list shows workers in a threaded program (#7)", async () => {
  await withSession("threaded", async (client, fx) => {
    const bp = await send(client, "lldb_send", { command: `breakpoint set -n ${fx.breakFunc}` });
    assert.match(bp, /Breakpoint 1/, `breakpoint set output: ${bp}`);

    await send(client, "lldb_send", { command: "continue", timeoutMs: 60000 });

    const threads = await send(client, "lldb_send", { command: "thread list" });
    assert.match(threads, /thread #1/, `thread list output: ${threads}`);
  });
});
