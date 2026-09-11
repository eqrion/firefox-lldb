#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Exposes one owned CLI/PTY lifetime through MCP. Page automation uses
// firefox-devtools-mcp on the same Firefox via its reported Marionette port.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SEND_TIMEOUT_MS, validateTimeout, type SendResult } from "./pty-repl.js";
import { ReplOwner } from "./repl-owner.js";
import { marionettePort } from "../config.js";

// Fixed defaults so the firefox-devtools-mcp entry in .mcp.json can hard-code a
// matching --marionette-port. Override per-process via env if a port clashes.
const MARIONETTE_PORT = marionettePort();

const TOOLS: Tool[] = [
  {
    name: "lldb_launch",
    description:
      "Launch Firefox and the firefox-lldb REPL against a page, attach to the " +
      "wasm process, and wait for the (lldb) prompt. Returns the attach/banner " +
      "output and the marionettePort that firefox-devtools-mcp should " +
      "--connect-existing to. Call this before any firefox-devtools tool.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Page URL to debug (the wasm target)." },
        headless: {
          type: "boolean",
          description: "Run Firefox headlessly (default false, so you can watch).",
        },
        fire: {
          type: "string",
          description:
            "Optional JS to run in the page on the first continue, to trigger a " +
            "workload without a page driver (e.g. 'runMatmul()').",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "lldb_send",
    description:
      "Send one command to the (lldb) prompt and return its output. Use real " +
      "LLDB commands (breakpoint set, continue, thread list, frame variable, " +
      "disassemble, memory read, ...) plus firefox-lldb's `js p/bt/frame`. " +
      "`continue` returns when the target next stops; if it keeps running the " +
      "call times out (prompt=false) — use lldb_interrupt.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to type." },
        timeoutMs: {
          type: "number",
          description: `Max wait for the next prompt (default ${DEFAULT_SEND_TIMEOUT_MS}).`,
        },
      },
      required: ["command"],
    },
  },
  {
    name: "lldb_interrupt",
    description: "Send Ctrl-C to interrupt a running target, then wait for the stop output.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lldb_read",
    description:
      "Drain buffered async output (streamed page console messages, tab hints) " +
      "without sending a command.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Max wait for new output (default 2000)." },
      },
    },
  },
  {
    name: "lldb_shutdown",
    description: "Quit the REPL and tear down Firefox.",
    inputSchema: { type: "object", properties: {} },
  },
];

const owner = new ReplOwner();

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function sendText(r: SendResult): string {
  if (r.prompt) return r.output || "(no output)";
  return (
    (r.output ? r.output + "\n\n" : "") +
    "[no prompt returned — the target is likely still running; " +
    "call lldb_interrupt to stop it, or lldb_read to watch output]"
  );
}

function timeoutArg(value: unknown, fallback: number): number {
  const timeout = Number(value ?? fallback);
  validateTimeout(timeout);
  return timeout;
}

async function call(name: string, args: Record<string, unknown>) {
  const repl = owner.active;
  switch (name) {
    case "lldb_launch": {
      const launched = await owner.replace({
        url: String(args.url),
        headless: Boolean(args.headless ?? false),
        marionettePort: MARIONETTE_PORT,
        fire: args.fire ? String(args.fire) : undefined,
      });
      const banner = await launched.read(0);
      return text(
        `Attached. firefox-devtools-mcp can --connect-existing --marionette-port ${MARIONETTE_PORT}.` +
          (banner ? `\n\n${banner}` : "")
      );
    }
    case "lldb_send": {
      if (!repl) return text("error: no session — call lldb_launch first");
      const r = await repl.send(
        String(args.command),
        timeoutArg(args.timeoutMs, DEFAULT_SEND_TIMEOUT_MS)
      );
      return text(sendText(r));
    }
    case "lldb_interrupt": {
      if (!repl) return text("error: no session — call lldb_launch first");
      return text(sendText(await repl.interrupt()));
    }
    case "lldb_read": {
      if (!repl) return text("error: no session — call lldb_launch first");
      return text((await repl.read(timeoutArg(args.timeoutMs, 2000))) || "(no output)");
    }
    case "lldb_shutdown": {
      await owner.shutdown();
      return text("shut down");
    }
    default:
      return text(`error: unknown tool ${name}`);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "firefox-lldb", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await call(req.params.name, req.params.arguments ?? {});
    } catch (e) {
      return { ...text(`error: ${(e as Error).message}`), isError: true };
    }
  });

  const shutdown = async () => {
    try {
      await owner.close();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  server.onclose = () => {
    void shutdown();
  };

  // An MCP client that dies without cleanly closing stdio (e.g. killed via
  // SIGKILL, which doesn't cascade to children) never signals us, orphaning
  // this process and the Firefox it launched. Poll for reparenting to
  // init/launchd (ppid 1) and shut down cleanly when it happens.
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) void shutdown();
  }, 1000);
  orphanCheck.unref();

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
