#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Debug Adapter Protocol entry point for the embedded wasm LLDB. Stdout is a
// protocol-only byte stream; all diagnostics stay on stderr.

import { readFile } from "node:fs/promises";
import { LLDBClient, type DAPSession } from "lldb-wasm";
import { parseCliArgs } from "./options.js";
import { startPlatformServer } from "../core/platform-session.js";
import { DebugFileRegistry } from "../symbols/debug-files.js";
import { debugEnvEnabled } from "../config.js";
import { createLogger } from "./logger.js";
import { EmbeddedLldbBridge } from "../lldb/bridge.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { DapTrace } from "../diagnostics/dap-trace.js";
import {
  captureFatalErrors,
  defaultLogPath,
  formatErrorWithLog,
  openSessionLog,
  temporaryLogPath,
} from "../diagnostics/session-log.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const persistentLog = args.log;
  const sessionLog = openSessionLog(
    persistentLog ? defaultLogPath() : temporaryLogPath(),
    process.argv.slice(2)
  );
  sessionLog.captureStdio();
  let fatalCleanup: (() => Promise<void>) | undefined;
  captureFatalErrors(sessionLog, () => fatalCleanup?.());
  if (persistentLog) process.stderr.write(`logging this session to ${sessionLog.path}\n`);
  const logger = createLogger({
    verbose: args.verbose || debugEnvEnabled(),
    quiet: true,
    sessionLog,
  });
  const client = await LLDBClient.create({ logger });
  const dapTrace = new DapTrace(logger);
  const bridge = new EmbeddedLldbBridge(client, logger);
  const debugFiles = new DebugFileRegistry(logger);
  client.setFileProvider(
    async (path) => (await debugFiles.read(path)) ?? readFile(path).catch(() => null)
  );

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let startup: ReturnType<typeof startPlatformServer> | undefined;
  const startupAbort = new AbortController();
  let dap: DAPSession | undefined;
  let session: RdpWasmSession | undefined;
  let exiting = false;
  let exitCode = 0;
  let failureReported = false;
  let startupRetried = false;
  const reportFailure = (error: unknown): void => {
    if (failureReported) return;
    session?.logState("error");
    bridge.logState();
    dapTrace.logState("failure");
    logger.error(formatErrorWithLog(error, sessionLog));
    failureReported = true;
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (code: number): Promise<void> => {
    exitCode ||= code;
    process.exitCode = exitCode;
    if (cleanupPromise) return cleanupPromise;
    exiting = true;
    return (cleanupPromise = Promise.resolve().then(async () => {
      startupAbort.abort(new Error("platform startup cancelled by shutdown"));
      const cleanupKeepalive = setInterval(() => {}, 1000);
      await startup?.catch((error) => {
        if (error instanceof AggregateError) {
          reportFailure(error);
          exitCode ||= 1;
          process.exitCode = exitCode;
        }
      });
      try {
        await bridge.close();
      } catch (error) {
        logger.error(`[cleanup] ${String(error)}`);
        exitCode ||= 1;
        process.exitCode = exitCode;
      }
      try {
        await handle?.shutdown();
      } catch (error) {
        logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
        exitCode ||= 1;
        process.exitCode = exitCode;
      }
      try {
        debugFiles.close();
        await client.destroy();
      } catch (error) {
        logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
        exitCode ||= 1;
        process.exitCode = exitCode;
      }
      if (bridge.failure && !failureReported)
        reportFailure(new Error(`embedded bridge failed: ${bridge.failure}`));
      if (exitCode !== 0 && !failureReported) {
        session?.logState("cleanup-failed");
        logger.error(formatErrorWithLog(new Error("session cleanup failed"), sessionLog));
      }
      dapTrace.end("client->adapter");
      dapTrace.end("adapter->client");
      dapTrace.logState("shutdown");
      if (startupRetried && !persistentLog && !failureReported)
        process.stderr.write(
          `Session transcript retained after startup retry at ${sessionLog.path}\n`
        );
      sessionLog.close({
        remove: exitCode === 0 && !persistentLog && !failureReported && !startupRetried,
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

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => {
      void (dap?.close() ?? Promise.resolve()).finally(() => cleanup(0));
    });
  }
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) void (dap?.close() ?? Promise.resolve()).finally(() => cleanup(0));
  }, 1000);
  orphanCheck.unref();

  try {
    handle = await (startup = startPlatformServer(args, {
      signal: startupAbort.signal,
      wrapConnectPort: (port) => bridge.bridgeTcp(port),
      logger,
      debugFiles,
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
    if (exiting) return;
    const platformChannel = await bridge.bridgeTcp(handle.port, "platform");
    dap = await client.startDAP({
      preInitCommands: [
        "platform select remote-gdb-server",
        `platform connect inprocess://${platformChannel}`,
      ],
      noLldbInit: true,
    });

    dap.onData((data) => {
      dapTrace.feed("adapter->client", data);
      process.stdout.write(data);
    });
    process.stdin.on("data", (data: Buffer) => {
      dapTrace.feed("client->adapter", data);
      void dap!.write(new Uint8Array(data)).catch((error) => {
        reportFailure(error);
        void cleanup(1);
      });
    });
    process.stdin.on("end", () => {
      dapTrace.end("client->adapter");
      dapTrace.logState("stdin-ended");
      void dap!.close();
    });
    process.stdin.resume();

    await dap.done;
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    await cleanup(0);
  } catch (error) {
    if (exiting) return;
    reportFailure(error);
    await cleanup(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
