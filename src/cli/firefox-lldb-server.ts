#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Standalone platform server CLI: same bring-up as the embedded firefox-lldb
// wrapper, but LLDB reaches it over a real TCP port instead of an in-process
// bridge, for use with an external native lldb.

import { pathToFileURL } from "node:url";
import { parseCliArgs } from "./options.js";
import { startPlatformServer } from "../core/platform-session.js";
import { exitWhenOrphaned, debugEnvEnabled } from "../config.js";
import { createLogger } from "./logger.js";
import {
  captureFatalErrors,
  defaultLogPath,
  formatErrorWithLog,
  openSessionLog,
  temporaryLogPath,
} from "../diagnostics/session-log.js";
import type { RdpWasmSession } from "../rdp/session.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();

  const persistentLog = args.log;
  const sessionLog = openSessionLog(
    persistentLog ? defaultLogPath() : temporaryLogPath(),
    process.argv.slice(2)
  );
  sessionLog.captureStdio({ stdout: true });
  let fatalCleanup: (() => Promise<void>) | undefined;
  captureFatalErrors(sessionLog, () => fatalCleanup?.());
  if (persistentLog) process.stderr.write(`logging this session to ${sessionLog.path}\n`);
  const logger = createLogger({ verbose, quiet: false, sessionLog });

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let startup: ReturnType<typeof startPlatformServer> | undefined;
  const startupAbort = new AbortController();
  let session: RdpWasmSession | undefined;
  const reportFailure = (error: unknown): void => {
    session?.logState("error");
    logger.error(formatErrorWithLog(error, sessionLog));
  };
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let exitCode = 0;
  let startupRetried = false;
  const cleanup = (code = 0): Promise<void> => {
    exitCode ||= code;
    process.exitCode = exitCode;
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    const keepalive = setInterval(() => {}, 1000);
    return (shutdownPromise = Promise.resolve().then(async () => {
      startupAbort.abort(new Error("platform startup cancelled by shutdown"));
      try {
        await startup?.catch((error) => {
          if (error instanceof AggregateError) throw error;
        });
        await handle?.shutdown();
        if (startupRetried && !persistentLog)
          process.stderr.write(
            `Session transcript retained after startup retry at ${sessionLog.path}\n`
          );
        sessionLog.close({ remove: exitCode === 0 && !persistentLog && !startupRetried });
      } catch (error) {
        reportFailure(error);
        sessionLog.close();
        process.exitCode = 1;
      } finally {
        clearInterval(keepalive);
        process.exit();
      }
    }));
  };
  fatalCleanup = () => cleanup(1);
  const onSignal = () => {
    void cleanup();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    handle = await (startup = startPlatformServer(args, {
      signal: startupAbort.signal,
      logger,
      onStartupRetry: () => {
        startupRetried = true;
      },
      onRdpSession: (rdpSession) => {
        session = rdpSession;
      },
    }));
    void handle.failed.then((error) => {
      reportFailure(error);
      return cleanup(1);
    });
    if (shuttingDown) return;
  } catch (err) {
    if (shuttingDown) return;
    reportFailure(err);
    await cleanup(1);
    return;
  }
  // Stdout is the control channel for the firefox-lldb wrapper; stderr carries logs.
  process.stdout.write(`platform server ready on connect://localhost:${handle.port}\n`);

  // When launched session-detached (e.g. the e2e harness uses setsid), a killed
  // parent does not signal us, so we would orphan the launched Firefox. Poll for
  // reparenting to init/launchd (ppid 1) and shut down cleanly when it happens.
  if (exitWhenOrphaned()) {
    const timer = setInterval(() => {
      if (process.ppid === 1) {
        onSignal();
      }
    }, 1000);
    timer.unref();
  }
}

// Only run as a CLI when invoked directly, not when imported for in-process use.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
