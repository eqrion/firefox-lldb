/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Convenience wrapper: run the platform server in-process and drive an embedded
// LLDB (compiled to WebAssembly) as a real interactive (lldb) prompt on this
// terminal. No native lldb binary is required.
//
// The wasm LLDB cannot open TCP sockets, so its RSP connections (the platform
// connection and each per-tab GDB server) are bridged to the in-process TCP
// servers through in-memory channels: LLDB connects to "inprocess://<id>" and
// we pump bytes between channel <id> and a localhost socket.

import net from "node:net";
import { LLDBClient } from "@firefox-devtools/lldb-wasm";
import { parseCliArgs, startPlatformServer } from "./firefox-lldb-server.js";

// Open bridge sockets, tracked so we can tear them down on exit (otherwise
// net.Server.close() blocks on the live connections).
const bridgeSockets = new Set<net.Socket>();

// Bridge a localhost TCP RSP server to an in-process channel the wasm LLDB
// connects to via "inprocess://<id>". Returns the channel ID.
async function bridgeTcp(client: LLDBClient, port: number): Promise<number> {
  const channelId = await client.createChannel();
  const socket = net.connect(port, "127.0.0.1");
  bridgeSockets.add(socket);
  socket.on("close", () => bridgeSockets.delete(socket));
  socket.setNoDelay(true);
  // server -> LLDB
  socket.on("data", (d) => void client.channelServerWrite(channelId, new Uint8Array(d)));
  socket.on("error", () => {});
  // LLDB -> server
  await client.bridgeChannel(channelId, (data) => void socket.write(Buffer.from(data)));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return channelId;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  const client = await LLDBClient.create();

  // Each per-tab GDB server launched by qLaunchGDBServer gets bridged; the
  // platform server returns the channel ID as the connection "port" and the
  // wasm LLDB connects to inprocess://<id> (PlatformWasmRemoteGDBServer::MakeUrl).
  const handle = await startPlatformServer(args, {
    wrapConnectPort: (port) => bridgeTcp(client, port),
  });

  // Bridge the platform connection itself.
  const platformChannel = await bridgeTcp(client, handle.port);

  client.onOutput((bytes) => process.stdout.write(Buffer.from(bytes)));

  let exiting = false;
  const cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const s of bridgeSockets) s.destroy();
    await handle.shutdown().catch(() => {});
    client.destroy();
    process.exit(code);
  };
  client.onInterpreterExit(() => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));

  await client.runInterpreter();

  // Drive the same setup the native wrapper passed via `-o` options.
  const send = (line: string) => client.writeStdin(new TextEncoder().encode(line + "\n"));
  await send("platform select remote-gdb-server");
  await send(`platform connect inprocess://${platformChannel}`);
  // Alias so users can `attach --pid N` and get the wasm process plugin.
  await send("command alias attach process attach --plugin wasm");
  if (args.url) {
    process.stderr.write("[info] attaching (waiting for wasm to load)...\n");
    await send("process attach --plugin wasm --pid 1");
  } else {
    await send("platform process list");
  }

  // Feed the terminal to LLDB. Forward Ctrl-D (stdin end) as EOF; SIGINT exits
  // the session (interrupting a running target is a follow-up).
  process.stdin.on("data", (d) => void client.writeStdin(new Uint8Array(d)));
  process.stdin.on("end", () => void client.closeStdin());
  process.on("SIGINT", () => void cleanup(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
