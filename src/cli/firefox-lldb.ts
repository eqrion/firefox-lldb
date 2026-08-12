#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Convenience wrapper: run the platform server in-process and drive an embedded
// LLDB (compiled to WebAssembly) behind a language-generic (sdb) prompt on this
// terminal. No native lldb binary is required.
//
// The wasm LLDB cannot open TCP sockets, so its RSP connections (the platform
// connection and each per-tab GDB server) are bridged to the in-process TCP
// servers through in-memory channels: LLDB connects to "inprocess://<id>" and
// we pump bytes between channel <id> and a localhost socket.

import { readFile } from "node:fs/promises";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { focusFirefoxWindow } from "../rdp/firefox.js";
import { quietLogger } from "./logger.js";
import { runRepl } from "./repl.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { debugEnvEnabled } from "../config.js";
import { EmbeddedLldbComponentRuntime } from "../source-debugger/lldb-runtime.js";
import { SourceDebuggerSession } from "../source-debugger/session.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();
  const logger = quietLogger(verbose);

  const runtime = await EmbeddedLldbComponentRuntime.create({
    logger,
    fileProvider: (path) => readFile(path).catch(() => null),
  });
  let session: RdpWasmSession | undefined;
  const sourceDebuggerSession = new SourceDebuggerSession({
    components: [runtime.component],
    getRdpSession: () => session,
  });

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let exiting = false;
  const cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    for (const work of [sourceDebuggerSession.close(), handle?.shutdown(), runtime.close()]) {
      try {
        await work;
      } catch (err) {
        logger.error(`[cleanup] ${err instanceof Error ? err.message : String(err)}`);
        code = code || 1;
      }
    }
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
  let triggerInterrupt: (() => void) | undefined;
  const repl = runRepl({
    session: sourceDebuggerSession,
    onExit: () => void cleanup(0),
    onTargetResume: () => {
      if (handle?.firefoxPid !== undefined) focusFirefoxWindow(handle.firefoxPid);
    },
    onTargetInterrupt: () => triggerInterrupt?.(),
  });

  // Each per-tab GDB server launched by qLaunchGDBServer gets bridged; the
  // platform server returns the channel ID as the connection "port" and the
  // wasm LLDB connects to inprocess://<id> (PlatformWasmRemoteGDBServer::MakeUrl).
  try {
    handle = await startPlatformServer(args, {
      wrapConnectPort: runtime.bridgeTcp,
      runControl: runtime.runControl,
      logger,
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
          void runtime
            .command("process detach")
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
    await runtime.connectPlatform(handle.port);
    await runtime.command("command alias attach process attach --plugin wasm");

    let intro =
      "firefox-lldb source debugger — `attach --pid N` to attach, `help` for generic commands.";
    if (args.url) {
      repl.print(intro + "\nattaching...");
      intro = await runtime.attach(1, {
        onRetry: (attempt) =>
          repl.print(`automatic attach attempt ${attempt} was interrupted; retrying...`),
      });
    } else {
      const res = await runtime.command("platform process list");
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
