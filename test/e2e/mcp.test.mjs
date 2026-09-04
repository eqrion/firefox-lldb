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
const MCP_LAUNCH_TIMEOUT_MS = 120_000;
const MCP_TOOL_TIMEOUT_MARGIN_MS = 15_000;
const SESSION_TIMEOUT_MS = 150_000;

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: REPO,
    env: process.env,
    // "ignore" previously meant a hung MCP server left zero diagnostic trail --
    // pipe it through so DEBUG=1 (forwarded by the custom reporter) can show it.
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-e2e", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  if (process.env.DEBUG === "1") {
    transport.stderr?.on("data", (d) => console.error(`[mcp-server] ${d}`.trimEnd()));
  }
  return client;
}

const send = async (client, name, args = {}, options) => {
  const requestOptions =
    options ??
    (typeof args.timeoutMs === "number"
      ? { timeout: args.timeoutMs + MCP_TOOL_TIMEOUT_MARGIN_MS }
      : undefined);
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, requestOptions);
    return (res.content ?? []).map((c) => c.text ?? "").join("");
  } catch (error) {
    const operation = name === "lldb_send" ? `${name}(${String(args.command)})` : name;
    throw new Error(`${operation} failed`, { cause: error });
  }
};

async function missedStopDiagnostics(client) {
  const sections = [];
  const captureTool = async (label, name, args = {}) => {
    try {
      sections.push(`${label}:\n${await send(client, name, args)}`);
    } catch (error) {
      sections.push(
        `${label}:\n<failed: ${error instanceof Error ? error.message : String(error)}>`
      );
    }
  };

  // The continue request has returned without a prompt, so the target is
  // still running. Stop it before asking LLDB/RDP for state; otherwise every
  // subsequent REPL command would merely queue behind the outstanding run.
  await captureTool("interrupt", "lldb_interrupt");
  for (const command of [
    "process status",
    "breakpoint list 1",
    "thread list",
    "image list",
    "js p document.location.href",
    "js p document.readyState",
    "js p document.getElementById('fac-result').textContent",
  ]) {
    await captureTool(command, "lldb_send", { command });
  }
  return sections.join("\n\n");
}

// Race `work` against a deadline. A hung MCP tool call (e.g. the launched
// Firefox wedges) leaves node's own --test-timeout as the only thing that
// eventually notices -- but that only abandons the promise, it doesn't kill
// the spawned MCP server process, which isn't orphaned (its parent, this
// test's own file-level worker, is still alive running other tests) and so
// never gets reaped either. Losing this race still throws, which runs the
// caller's normal try/finally cleanup instead of leaving it dangling forever.
function withDeadline(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function withSession(
  fxName,
  fn,
  { page = "index.html", fire, crossOriginIsolation = true } = {}
) {
  const fx = FIXTURES[fxName];
  const staticServer = await startStaticServer(fx.pageDir, { crossOriginIsolation });
  const url = `http://127.0.0.1:${staticServer.port}/${page}`;
  const client = await connect();
  try {
    await withDeadline(
      (async () => {
        // PtyRepl allows startup to take 90 seconds, so override the MCP
        // SDK's 60-second request default. A loaded CI runner can cross the
        // SDK deadline while the launch is still making valid progress.
        const banner = await send(
          client,
          "lldb_launch",
          {
            url,
            headless: true,
            fire: fire ?? fx.fire,
          },
          { timeout: MCP_LAUNCH_TIMEOUT_MS }
        );
        assert.match(banner, /marionette-port \d+/, `launch banner: ${banner}`);
        await fn(client, fx, banner);
      })(),
      SESSION_TIMEOUT_MS
    );
  } finally {
    // A graceful shutdown RPC depends on the (possibly wedged) server
    // responding; bound it so a hang there can't stop us from reaching the
    // forceful client.close() below, which kills the process directly.
    await withDeadline(send(client, "lldb_shutdown"), 5_000).catch(() => {});
    await withDeadline(client.close(), 10_000).catch(() => {});
    // close() alone waits for open connections to end naturally, which can
    // hang forever on a lingering keep-alive socket; force them closed too.
    staticServer.server.closeAllConnections();
    await new Promise((r) => staticServer.server.close(r));
  }
}

test("MCP: launch, set a breakpoint, continue, hit it", async () => {
  await withSession("factorial", async (client, fx, banner) => {
    const bp = await send(client, "lldb_send", { command: `breakpoint set -n ${fx.breakFunc}` });
    assert.match(bp, /Breakpoint 1/, `breakpoint set output: ${bp}`);

    const cont = await send(client, "lldb_send", { command: "continue", timeoutMs: 60000 });
    if (!new RegExp(fx.breakFunc).test(cont)) {
      const diagnostics = await missedStopDiagnostics(client);
      assert.match(
        cont,
        new RegExp(fx.breakFunc),
        `launch banner: ${banner}\n\nbreakpoint set output: ${bp}\n\ncontinue/stop output: ${cont}\n\n${diagnostics}`
      );
    }

    const frame = await send(client, "lldb_send", { command: "frame variable" });
    assert.ok(frame.length > 0, "frame variable returned output");

    // MCP clients may issue tool calls concurrently. The PTY driver must keep
    // command echoes/results paired rather than interleaving writes.
    const [version, target] = await Promise.all([
      send(client, "lldb_send", { command: "version" }),
      send(client, "lldb_send", { command: "target list" }),
    ]);
    assert.match(version, /lldb version/i);
    assert.match(target, /Current targets|target #0/i);

    // With no more work and no breakpoints, continue never produces another
    // prompt. Omitting timeoutMs must let the server return its documented
    // no-prompt result before the MCP SDK's own 60-second request deadline.
    await send(client, "lldb_send", { command: "breakpoint delete 1" });
    const running = await send(client, "lldb_send", { command: "continue" });
    assert.match(running, /no prompt returned/i, `continue output: ${running}`);
    const interrupted = await send(client, "lldb_interrupt");
    assert.doesNotMatch(interrupted, /no prompt returned/i, `interrupt output: ${interrupted}`);
  });
});

test("MCP: launch survives a page reload racing automatic attach (#46)", async () => {
  await withSession(
    "factorial",
    async (client, fx, banner) => {
      assert.match(banner, /page navigating; re-syncing/i, `launch banner: ${banner}`);
      assert.match(banner, /Process 1 stopped/i, `launch banner: ${banner}`);
      assert.doesNotMatch(banner, /attach failed/i, `launch banner: ${banner}`);
      const bp = await send(client, "lldb_send", { command: `breakpoint set -n ${fx.breakFunc}` });
      assert.match(bp, /Breakpoint 1/, `breakpoint set output: ${bp}`);
    },
    { page: "reload-service-worker.html", crossOriginIsolation: false }
  );
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
