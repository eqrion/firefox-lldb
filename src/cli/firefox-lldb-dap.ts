#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Debug Adapter Protocol entry point for the embedded wasm LLDB. Stdout is a
// protocol-only byte stream; all diagnostics stay on stderr.

import { readFile } from "node:fs/promises";
import { LLDBClient, type DAPSession } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { DebugFileRegistry } from "../core/debug-files.js";
import { debugEnvEnabled } from "../config.js";
import { createLogger } from "./logger.js";
import { EmbeddedLldbBridge } from "./embedded-lldb.js";
import type { RdpWasmSession } from "../rdp/session.js";
import {
  captureFatalErrors,
  defaultLogPath,
  formatErrorWithLog,
  openSessionLog,
  temporaryLogPath,
} from "./session-log.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const persistentLog = args.log;
  const sessionLog = openSessionLog(
    persistentLog ? defaultLogPath() : temporaryLogPath(),
    process.argv.slice(2)
  );
  sessionLog.captureStdio();
  captureFatalErrors(sessionLog);
  if (persistentLog) process.stderr.write(`logging this session to ${sessionLog.path}\n`);
  const logger = createLogger({
    verbose: args.verbose || debugEnvEnabled(),
    quiet: true,
    sessionLog,
  });
  const client = await LLDBClient.create({ logger });
  const bridge = new EmbeddedLldbBridge(client, logger);
  const debugFiles = new DebugFileRegistry(logger);
  client.setFileProvider(
    async (path) => (await debugFiles.read(path)) ?? readFile(path).catch(() => null)
  );

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let dap: DAPSession | undefined;
  let session: RdpWasmSession | undefined;
  let exiting = false;
  let exitCode = 0;
  let failureReported = false;
  const reportFailure = (error: unknown): void => {
    if (failureReported) return;
    session?.logState("error");
    logger.error(formatErrorWithLog(error, sessionLog));
    failureReported = true;
  };
  const cleanup = async (code: number): Promise<void> => {
    exitCode ||= code;
    process.exitCode = exitCode;
    if (exiting) return;
    exiting = true;
    const cleanupKeepalive = setInterval(() => {}, 1000);
    bridge.close();
    try {
      await handle?.shutdown();
    } catch (error) {
      logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
      exitCode ||= 1;
      process.exitCode = exitCode;
    }
    try {
      await client.destroy();
    } catch (error) {
      logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
      exitCode ||= 1;
      process.exitCode = exitCode;
    }
    if (exitCode !== 0 && !failureReported) {
      session?.logState("cleanup-failed");
      logger.error(formatErrorWithLog(new Error("session cleanup failed"), sessionLog));
    }
    sessionLog.close({ remove: exitCode === 0 && !persistentLog });
    clearInterval(cleanupKeepalive);
    process.exit(exitCode);
  };

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
    handle = await startPlatformServer(
      { ...args, log: true },
      {
        wrapConnectPort: (port) => bridge.bridgeTcp(port),
        logger,
        debugFiles,
        onRdpSession: (rdpSession) => {
          session = rdpSession;
        },
        onGdbWorkerFailure: (error) => {
          reportFailure(error);
          void (dap?.close() ?? Promise.resolve()).finally(() => cleanup(1));
        },
      }
    );
    const platformChannel = await bridge.bridgeTcp(handle.port);
    dap = await client.startDAP({
      preInitCommands: [
        "platform select remote-gdb-server",
        `platform connect inprocess://${platformChannel}`,
      ],
      noLldbInit: true,
    });

    dap.onData((data) => process.stdout.write(data));
    process.stdin.on("data", (data: Buffer) => {
      void dap!.write(new Uint8Array(data)).catch((error) => {
        reportFailure(error);
        void cleanup(1);
      });
    });
    process.stdin.on("end", () => void dap!.close());
    process.stdin.resume();

    void handle.firefoxExited?.then(() => dap?.close());
    await dap.done;
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    await cleanup(0);
  } catch (error) {
    reportFailure(error);
    await cleanup(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
