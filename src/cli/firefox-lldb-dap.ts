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

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const logger = createLogger({ verbose: args.verbose || debugEnvEnabled(), quiet: true });
  const client = await LLDBClient.create();
  const bridge = new EmbeddedLldbBridge(client, logger);
  const debugFiles = new DebugFileRegistry(logger);
  client.setFileProvider(
    async (path) => (await debugFiles.read(path)) ?? readFile(path).catch(() => null)
  );

  let handle: Awaited<ReturnType<typeof startPlatformServer>> | undefined;
  let dap: DAPSession | undefined;
  let exiting = false;
  const cleanup = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    bridge.close();
    try {
      await handle?.shutdown();
    } catch (error) {
      logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
      code ||= 1;
    }
    try {
      await client.destroy();
    } catch (error) {
      logger.error(`[cleanup] ${error instanceof Error ? error.message : String(error)}`);
      code ||= 1;
    }
    process.exit(code);
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
    handle = await startPlatformServer(args, {
      wrapConnectPort: (port) => bridge.bridgeTcp(port),
      logger,
      debugFiles,
    });
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
        logger.error(error instanceof Error ? error.message : String(error));
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
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    await cleanup(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
