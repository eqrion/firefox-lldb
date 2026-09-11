#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Interactive entry point: owns embedded LLDB, the runtime and the terminal.
// The shared LLDB bridge connects in-process channels to local RSP listeners.

import { readFile } from "node:fs/promises";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs } from "./options.js";
import { startPlatformServer } from "../core/platform-session.js";
import { DebugFileRegistry } from "../symbols/debug-files.js";
import { focusFirefoxWindow } from "../core/firefox.js";
import { createLogger } from "./logger.js";
import {
  captureFatalErrors,
  defaultLogPath,
  formatErrorWithLog,
  openSessionLog,
  temporaryLogPath,
} from "../diagnostics/session-log.js";
import { runRepl } from "./repl.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { debugEnvEnabled, ptyPromptMarker } from "../config.js";
import { EmbeddedLldbBridge } from "../lldb/bridge.js";
import { attachLldb } from "../lldb/attach.js";

async function main(): Promise<void> {
  let navigationRevision = 0;
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();

  const persistentLog = args.log;
  const sessionLog = openSessionLog(
    persistentLog ? defaultLogPath() : temporaryLogPath(),
    process.argv.slice(2)
  );
  sessionLog.captureStdio();
  let fatalCleanup: (() => Promise<void>) | undefined;
  captureFatalErrors(sessionLog, () => fatalCleanup?.());
  if (persistentLog) process.stderr.write(`logging this session to ${sessionLog.path}\n`);
  const logger = createLogger({ verbose, quiet: true, sessionLog });

  const client = await LLDBClient.create({ logger });
  const bridge = new EmbeddedLldbBridge(client, logger);
  // A module's separate DWARF file is fetched from the page's server; anything
  // else LLDB opens (source text, a local symbol file) comes off local disk.
  const debugFiles = new DebugFileRegistry(logger);
  client.setFileProvider(
    async (path) => (await debugFiles.read(path)) ?? readFile(path).catch(() => null)
  );

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let startup: ReturnType<typeof startPlatformServer> | undefined;
  const startupAbort = new AbortController();
  let session: RdpWasmSession | undefined;
  let exiting = false;
  let exitCode = 0;
  let failureReported = false;
  let attachRetried = false;
  const reportFailure = (err: unknown) => {
    session?.logState("error");
    bridge.logState();
    logger.error(formatErrorWithLog(err, sessionLog));
    failureReported = true;
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (code = 0): Promise<void> => {
    exitCode ||= code;
    process.exitCode = exitCode;
    if (cleanupPromise) return cleanupPromise;
    exiting = true;
    return (cleanupPromise = Promise.resolve().then(async () => {
      startupAbort.abort(new Error("platform startup cancelled by shutdown"));
      // LLDB worker teardown can release Node's final referenced handle before
      // this async function reaches process.exit(). Preserve the intended status
      // if the runtime exits naturally while cleanup is still settling.
      const cleanupKeepalive = setInterval(() => {}, 1000);
      await startup?.catch((error) => {
        if (error instanceof AggregateError) {
          reportFailure(error);
          exitCode ||= 1;
          process.exitCode = exitCode;
        }
      });
      for (const work of [
        () => bridge.close(),
        () => handle?.shutdown(),
        () => debugFiles.close(),
        () => client.destroy(),
      ]) {
        try {
          await work();
        } catch (err) {
          logger.error(`[cleanup] ${err instanceof Error ? err.message : String(err)}`);
          exitCode ||= 1;
          process.exitCode = exitCode;
        }
      }
      if (bridge.failure && !failureReported)
        reportFailure(new Error(`embedded bridge failed: ${bridge.failure}`));
      if (exitCode !== 0 && !failureReported) {
        session?.logState("cleanup-failed");
        logger.error(formatErrorWithLog(new Error("session cleanup failed"), sessionLog));
      }
      if (attachRetried && !failureReported && !persistentLog)
        process.stderr.write(
          `Session transcript retained after attach retry at ${sessionLog.path}\n`
        );
      sessionLog.close({
        remove: exitCode === 0 && !persistentLog && !failureReported && !attachRetried,
      });
      clearInterval(cleanupKeepalive);
      process.exit(exitCode);
    }));
  };
  fatalCleanup = () => cleanup(1);
  void bridge.failed.then((error) => {
    reportFailure(error);
    return cleanup(1);
  });
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
    promptMarker: ptyPromptMarker(),
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
    handle = await (startup = startPlatformServer(args, {
      signal: startupAbort.signal,
      wrapConnectPort: (port) => bridge.bridgeTcp(port),
      logger,
      debugFiles,
      onStartupRetry: () => {
        attachRetried = true;
      },
      onRdpSession: (rdpSession) => {
        session = rdpSession;
      },
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
          navigationRevision++;
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
    }));
    void handle.failed.then((error) => {
      reportFailure(error);
      return cleanup(1);
    });
    if (exiting) return;

    // Bridge the platform connection itself, then drive the platform setup the
    // native wrapper used to pass via `-o`. These produce noisy connect chatter,
    // so we run them quietly and only surface the attach / tab list.
    const platformChannel = await bridge.bridgeTcp(handle.port, "platform");
    await client.sessionCommand("platform select remote-gdb-server");
    await client.sessionCommand(`platform connect inprocess://${platformChannel}`);
    await client.sessionCommand("command alias attach process attach --plugin wasm");

    let intro = "firefox-lldb — `attach --pid N` to attach, `js p <expr>` to evaluate JS.";
    if (args.url) {
      repl.print(intro + "\nattaching...");
      intro = await attachLldb(client, 1, {
        navigationRevision: () => navigationRevision,
        logger,
        onRetry: (attempt) => {
          attachRetried = true;
          repl.print(
            `automatic attach attempt ${attempt} was interrupted by navigation; retrying...`
          );
        },
      });
    } else {
      const res = await client.sessionCommand("platform process list");
      intro += "\n" + res.output.trimEnd();
    }
    repl.start(intro);
  } catch (err) {
    if (exiting) return;
    reportFailure(err);
    await cleanup(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
