/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// MCP stdio server exposing the firefox-lldb REPL to a coding agent. It holds a
// single debug session (a real CLI driven in a pty; see pty-repl.ts) and turns
// REPL interaction into request/response tools. Page automation (navigate,
// click, screenshot) is left to firefox-devtools-mcp, which connects to the
// *same* Firefox over Marionette on `marionettePort` — call lldb_launch first.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { freePort } from "../platform/gdb-server-spawner.js";
import { PtyRepl, type SendResult } from "./pty-repl.js";

// Fixed defaults so the firefox-devtools-mcp entry in .mcp.json can hard-code a
// matching --marionette-port. Override per-process via env if a port clashes.
const MARIONETTE_PORT = Number(process.env.FIREFOX_LLDB_MARIONETTE_PORT ?? 2828);

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
          description: "Max wait for the next prompt (default 60000).",
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

let repl: PtyRepl | undefined;

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

async function call(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "lldb_launch": {
      if (repl) {
        await repl.shutdown().catch(() => {});
        repl = undefined;
      }
      repl = await PtyRepl.launch({
        url: String(args.url),
        headless: Boolean(args.headless ?? false),
        rdpPort: await freePort(),
        marionettePort: MARIONETTE_PORT,
        fire: args.fire ? String(args.fire) : undefined,
      });
      const banner = await repl.read(500);
      return text(
        `Attached. firefox-devtools-mcp can --connect-existing --marionette-port ${MARIONETTE_PORT}.` +
          (banner ? `\n\n${banner}` : "")
      );
    }
    case "lldb_send": {
      if (!repl) return text("error: no session — call lldb_launch first");
      const r = await repl.send(String(args.command), Number(args.timeoutMs ?? 60_000));
      return text(sendText(r));
    }
    case "lldb_interrupt": {
      if (!repl) return text("error: no session — call lldb_launch first");
      return text(sendText(await repl.interrupt()));
    }
    case "lldb_read": {
      if (!repl) return text("error: no session — call lldb_launch first");
      return text((await repl.read(Number(args.timeoutMs ?? 2000))) || "(no output)");
    }
    case "lldb_shutdown": {
      if (!repl) return text("no session");
      await repl.shutdown().catch(() => {});
      repl = undefined;
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
    await repl?.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
