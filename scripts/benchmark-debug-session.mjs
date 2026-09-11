/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Compare the production transcript/trace path with a no-file/no-component-trace
// baseline. Both modes use the same Firefox, LLDB, bridge, fixture, and commands.
// Usage: node --import tsx scripts/benchmark-debug-session.mjs [measured-pairs=3]

import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLDBClient } from "lldb-wasm";
import { EmbeddedLldbBridge } from "../src/lldb/bridge.ts";
import { attachLldb, LLDB_FAILED_STATUS } from "../src/lldb/attach.ts";
import { parseCliArgs } from "../src/cli/options.ts";
import { startPlatformServer } from "../src/core/platform-session.ts";
import { openSessionLog } from "../src/diagnostics/session-log.ts";
import { noopLogger } from "../src/diagnostics/logger.ts";
import { freePort } from "../src/platform/gdb-server-spawner.ts";
import { startStaticServer } from "../test/e2e/harness.mjs";

const pairs = Number(process.argv[2] ?? 3);
assert.ok(Number.isInteger(pairs) && pairs > 0 && pairs <= 20);
const directory = mkdtempSync(join(tmpdir(), "firefox-lldb-session-benchmark-"));
const fixture = await startStaticServer("test/fixtures/simple");
const samples = [];
try {
  for (let pair = -1; pair < pairs; pair++) {
    // Alternate order; pair -1 warms both paths and is not measured.
    for (const mode of pair % 2 === 0 ? ["normal", "baseline"] : ["baseline", "normal"]) {
      const log =
        mode === "normal"
          ? openSessionLog(join(directory, `${pair}.log`), ["session-benchmark"])
          : undefined;
      const logger = log
        ? Object.fromEntries(
            ["debug", "info", "warn", "error"].map((level) => [
              level,
              (message) => log.record("debug", `${level} ${message}`),
            ])
          )
        : noopLogger;
      let client, bridge, handle;
      const begin = performance.now();
      const cpu = process.cpuUsage();
      let attachMs, commandsMs;
      try {
        client = await LLDBClient.create({ logger });
        bridge = new EmbeddedLldbBridge(client, logger);
        handle = await startPlatformServer(
          {
            ...parseCliArgs([
              "--launch",
              "--headless",
              "--port",
              "0",
              "--rdp-port",
              String(await freePort()),
              "--url",
              `http://127.0.0.1:${fixture.port}/index.html`,
              "--fire",
              "runFactorial()",
              ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
            ]),
            trace: mode === "normal",
          },
          { logger, onTab() {}, wrapConnectPort: (port) => bridge.bridgeTcp(port) }
        );
        const channel = await bridge.bridgeTcp(handle.port, "platform");
        const command = async (text) => {
          const result = await client.sessionCommand(text);
          assert.ok(result.status < LLDB_FAILED_STATUS, `${text}: ${result.error}`);
          return result;
        };
        await command("platform select remote-gdb-server");
        await command(`platform connect inprocess://${channel}`);
        await attachLldb(client, 1, { logger });
        attachMs = performance.now() - begin;
        const commandsBegin = performance.now();
        await command("breakpoint set -n compute_factorial");
        const stopped = await command("continue");
        assert.match(stopped.output, /compute_factorial/);
        for (let step = 0; step < 10; step++) {
          await command("thread step-inst");
          await command("frame variable");
          await command("thread backtrace");
        }
        commandsMs = performance.now() - commandsBegin;
      } finally {
        try {
          await bridge?.close();
        } finally {
          try {
            await handle?.shutdown();
          } finally {
            await client?.destroy();
            log?.close();
          }
        }
      }
      const usage = process.cpuUsage(cpu);
      const sample = {
        pair,
        mode,
        attachMs,
        commandsMs,
        totalMs: performance.now() - begin,
        hostCpuMs: (usage.user + usage.system) / 1000,
        logBytes: log ? statSync(log.path).size : 0,
      };
      assert.equal(log?.failure, undefined);
      if (pair >= 0) samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
} finally {
  fixture.server.closeAllConnections();
  await new Promise((resolve) => fixture.server.close(resolve));
}
console.log(
  JSON.stringify({
    directory,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    samples,
    scope:
      "Full attach, 32 stopped debugger commands, and cleanup; CPU includes Node/wasm workers, excludes Firefox. Baseline retains producer formatting that precedes no-op logger calls.",
  })
);
