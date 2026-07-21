#!/usr/bin/env node
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
import { readFile } from "node:fs/promises";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { focusFirefoxWindow } from "../rdp/firefox.js";
import { quietLogger } from "./logger.js";
import { runRepl } from "./repl.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { debugEnvEnabled } from "../config.js";

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
  // Capture the connect result now: the loopback connect can complete during the
  // bridgeChannel await below, and a listener attached after that would miss the
  // one-shot "connect" event and hang forever.
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // server -> LLDB
  socket.on("data", (d) => void client.channelServerWrite(channelId, new Uint8Array(d)));
  socket.on("error", () => {});
  // LLDB -> server
  await client.bridgeChannel(channelId, (data) => void socket.write(Buffer.from(data)));
  await connected;
  return channelId;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();

  const client = await LLDBClient.create();
  client.setFileProvider((path) => readFile(path).catch(() => null));

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let exiting = false;
  const cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const s of bridgeSockets) s.destroy();
    await handle?.shutdown().catch(() => {});
    await client.destroy();
    process.exit(code);
  };
  process.on("SIGTERM", () => void cleanup(0));

  // A dead parent (e.g. a pty master closing, or a controlling process being
  // killed) doesn't always deliver a signal we handle -- SIGHUP's default
  // disposition just kills us without running cleanup, orphaning Firefox.
  // Poll for reparenting to init/launchd (ppid 1) and clean up when it happens.
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) void cleanup(0);
  }, 1000);
  orphanCheck.unref();

  // The REPL owns the terminal; `js` commands and console streaming need the
  // live RDP session, which the platform server hands us via onSession.
  let session: RdpWasmSession | undefined;
  let triggerInterrupt: (() => void) | undefined;
  const repl = runRepl({
    client,
    getSession: () => session,
    onExit: () => void cleanup(0),
    onTargetResume: () => {
      if (handle?.firefoxPid !== undefined) focusFirefoxWindow(handle.firefoxPid);
    },
    onTargetInterrupt: () => triggerInterrupt?.(),
  });

  // Each per-tab GDB server launched by qLaunchGDBServer gets bridged; the
  // platform server returns the channel ID as the connection "port" and the
  // wasm LLDB connects to inprocess://<id> (PlatformWasmRemoteGDBServer::MakeUrl).
  handle = await startPlatformServer(args, {
    wrapConnectPort: (port) => bridgeTcp(client, port),
    logger: quietLogger(verbose),
    onTab: (tab, pid) => repl.print(`tab available: ${tab.url}\n  attach --pid ${pid}`),
    onSession: (s, interrupt) => {
      session = s;
      triggerInterrupt = interrupt;
      void s.streamConsole((m) => repl.printConsole(m));
      // "navigated" fires as soon as the old top-level target is gone, before
      // the new one (if any) arrives — too early to know the destination URL.
      // Wait for the next top-level "target" to report where the page landed;
      // if none ever arrives, "detached" below reports the tab closed instead.
      let awaitingNavigationTarget = false;
      s.on("navigated", () => {
        repl.print("page navigating; re-syncing debug session...");
        awaitingNavigationTarget = true;
      });
      s.on("target", (info) => {
        if (!info.isTopLevel || !awaitingNavigationTarget) return;
        awaitingNavigationTarget = false;
        repl.print(`page navigated to ${info.url}`);
      });
      s.on("detached", () => {
        repl.print("the attached tab was closed; detaching.");
        session = undefined;
        triggerInterrupt = undefined;
        void client.sessionCommand("process detach").catch(() => {});
      });
    },
  });

  // Quit when a launched Firefox goes away (#24).
  void handle.firefoxExited?.then(() => {
    repl.print("Firefox exited.");
    void cleanup(0);
  });

  // Bridge the platform connection itself, then drive the platform setup the
  // native wrapper used to pass via `-o`. These produce noisy connect chatter,
  // so we run them quietly and only surface the attach / tab list.
  const platformChannel = await bridgeTcp(client, handle.port);
  await client.sessionCommand("platform select remote-gdb-server");
  await client.sessionCommand(`platform connect inprocess://${platformChannel}`);
  await client.sessionCommand("command alias attach process attach --plugin wasm");

  let intro = "firefox-lldb — `attach --pid N` to attach, `js p <expr>` to evaluate JS.";
  if (args.url) {
    repl.print(intro + "\nattaching...");
    const res = await client.sessionCommand("process attach --plugin wasm --pid 1");
    intro = (res.output + res.error).trimEnd();
  } else {
    const res = await client.sessionCommand("platform process list");
    intro += "\n" + res.output.trimEnd();
  }
  repl.start(intro);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
