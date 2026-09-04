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

import { readFile } from "node:fs/promises";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { DebugFileRegistry } from "../core/debug-files.js";
import { focusFirefoxWindow } from "../rdp/firefox.js";
import { createLogger } from "./logger.js";
import { captureFatalErrors, defaultLogPath, openSessionLog } from "./session-log.js";
import { runRepl } from "./repl.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { debugEnvEnabled } from "../config.js";
import { EmbeddedLldbBridge } from "./embedded-lldb.js";

// lldb::ReturnStatus values at or above this are failures. Keep the automatic
// attach retry local to the CLI: an uncontrolled page reload can invalidate the
// first per-tab server while `process attach` is in flight, but the platform is
// ready to launch a fresh one as soon as the replacement target arrives.
const LLDB_FAILED_STATUS = 6;
const AUTO_ATTACH_ATTEMPTS = 4;

async function attachWithRetry(
  client: LLDBClient,
  pid: number,
  onRetry?: (attempt: number) => void
): Promise<string> {
  let lastError = "unknown attach failure";
  for (let attempt = 1; attempt <= AUTO_ATTACH_ATTEMPTS; attempt++) {
    const result = await client.sessionCommand(`process attach --plugin wasm --pid ${pid}`);
    if (result.status < LLDB_FAILED_STATUS) {
      const state = await client.sessionState();
      if (state.reason !== "none" && state.reason !== "exited") {
        return (result.output + result.error).trimEnd();
      }
      lastError = `process did not stop (state ${state.reason})`;
    } else {
      lastError = (result.error || result.output).trim() || lastError;
    }
    if (attempt < AUTO_ATTACH_ATTEMPTS) {
      onRetry?.(attempt);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`automatic attach failed after ${AUTO_ATTACH_ATTEMPTS} attempts: ${lastError}`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();

  const sessionLog = args.log ? openSessionLog(defaultLogPath(), process.argv.slice(2)) : undefined;
  if (sessionLog) {
    sessionLog.captureStdio();
    captureFatalErrors(sessionLog);
    process.stderr.write(`logging this session to ${sessionLog.path}\n`);
  }
  const logger = createLogger({ verbose, quiet: true, sessionLog });

  const client = await LLDBClient.create();
  const bridge = new EmbeddedLldbBridge(client, logger);
  // A module's separate DWARF file is fetched from the page's server; anything
  // else LLDB opens (source text, a local symbol file) comes off local disk.
  const debugFiles = new DebugFileRegistry(logger);
  client.setFileProvider(
    async (path) => (await debugFiles.read(path)) ?? readFile(path).catch(() => null)
  );

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let exiting = false;
  const cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    bridge.close();
    for (const work of [handle?.shutdown(), client.destroy()]) {
      try {
        await work;
      } catch (err) {
        logger.error(`[cleanup] ${err instanceof Error ? err.message : String(err)}`);
        code = code || 1;
      }
    }
    sessionLog?.close();
    process.exit(code);
  };
  process.on("SIGTERM", () => void cleanup(0));
  process.on("SIGHUP", () => void cleanup(0));

  // A dead parent (e.g. a pty master closing, or a controlling process being
  // killed) doesn't always deliver a signal. Poll for reparenting to
  // init/launchd (ppid 1) and clean up when it happens.
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
    record: sessionLog?.record,
  });

  // Each per-tab GDB server launched by qLaunchGDBServer gets bridged; the
  // platform server returns the channel ID as the connection "port" and the
  // wasm LLDB connects to inprocess://<id> (PlatformWasmRemoteGDBServer::MakeUrl).
  try {
    handle = await startPlatformServer(args, {
      wrapConnectPort: (port) => bridge.bridgeTcp(port),
      logger,
      debugFiles,
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
          void client
            .sessionCommand("process detach")
            .catch((err) => logger.debug(`[cleanup] LLDB detach failed: ${String(err)}`));
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
    const platformChannel = await bridge.bridgeTcp(handle.port);
    await client.sessionCommand("platform select remote-gdb-server");
    await client.sessionCommand(`platform connect inprocess://${platformChannel}`);
    await client.sessionCommand("command alias attach process attach --plugin wasm");

    let intro = "firefox-lldb — `attach --pid N` to attach, `js p <expr>` to evaluate JS.";
    if (args.url) {
      repl.print(intro + "\nattaching...");
      intro = await attachWithRetry(client, 1, (attempt) =>
        repl.print(`automatic attach attempt ${attempt} was interrupted; retrying...`)
      );
    } else {
      const res = await client.sessionCommand("platform process list");
      intro += "\n" + res.output.trimEnd();
    }
    repl.start(intro);
  } catch (err) {
    logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    await cleanup(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
