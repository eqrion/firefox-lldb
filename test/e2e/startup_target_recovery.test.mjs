/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LLDBClient } from "lldb-wasm";
import { launchFirefox } from "../../src/core/firefox.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { parseCliArgs } from "../../src/cli/options.ts";
import { EmbeddedLldbBridge } from "../../src/lldb/bridge.ts";
import { attachLldb } from "../../src/lldb/attach.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { NavigationTargetLostError } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { startStaticServer, tracingLogger, platformConnect } from "./harness.mjs";

for (const mode of ["recover", "retry-limit", "shutdown"]) {
  test(
    `lost startup target ${mode} stays inside one owned acquisition`,
    { timeout: 35_000 },
    async (t) => {
      const trace = tracingLogger();
      const fixture = await startStaticServer("test/fixtures/threaded");
      const url = `http://127.0.0.1:${fixture.port}/index.html`;
      const port = await freePort();
      let firefox, proxy, platform, client, bridge, stopping;
      const sessions = [];
      const closedSessions = new Set();
      let recoveries = 0;
      const logger = {
        ...trace,
        warn(message) {
          trace.warn(message);
          if (message.includes("reacquiring lost startup target")) {
            console.error(`[harness] intentional startup-target loss: ${mode}`);
            recoveries++;
            if (mode === "shutdown") stopping = platform.shutdown();
          }
        },
      };
      t.after(async () => {
        try {
          await bridge?.close();
          await platform?.shutdown();
        } finally {
          await client?.destroy();
          await proxy?.close();
          await firefox?.close();
          fixture.server.closeAllConnections();
          await new Promise((resolve) => fixture.server.close(resolve));
          trace.close();
        }
      });
      firefox = await launchFirefox({
        rdpPort: port,
        headless: true,
        binary: process.env.FIREFOX_BINARY,
        logger,
      });
      await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
      const navigating = new Set();
      const withheldActors = new Set();
      const prefix = (actor) => actor?.match(/^server\d+\.conn\d+\./)?.[0];
      proxy = await packetGate(
        port,
        (packet) => {
          const connection = prefix(packet.from);
          const shouldHold =
            mode === "retry-limit" || connection === navigating.values().next().value;
          if (!shouldHold) return false;
          if (packet.type === "target-available-form" && navigating.has(connection)) {
            withheldActors.add(packet.target.actor);
            return true;
          }
          return withheldActors.has(packet.from);
        },
        (packet) => {
          if (packet.type === "navigateTo") navigating.add(prefix(packet.to));
        }
      );
      if (mode === "recover") {
        client = await LLDBClient.create({ logger });
        bridge = new EmbeddedLldbBridge(client, logger);
      }
      platform = await startPlatformServer(
        parseCliArgs(["--connect", "--port", "0", "--rdp-port", String(proxy.port), "--url", url]),
        {
          logger,
          onTab() {},
          onRdpSession(session) {
            if (sessions.length)
              assert.equal(
                closedSessions.has(sessions[0]),
                true,
                "rollback precedes reacquisition"
              );
            session.once("close", () => closedSessions.add(session));
            sessions.push(session);
          },
          wrapConnectPort: bridge ? (port) => bridge.bridgeTcp(port) : undefined,
        }
      );
      if (mode === "recover") {
        await platformConnect(client, await bridge.bridgeTcp(platform.port), trace);
        await attachLldb(client, 1, { logger });
        assert.match(
          (await client.sessionCommand("breakpoint set -n matmul_threaded")).output,
          /Breakpoint/
        );
        assert.equal(platform.spawner.list().length, 1);
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0].tabId, sessions[1].tabId);
      } else {
        await assert.rejects(
          platform.spawner.launch(0, url),
          mode === "retry-limit" ? NavigationTargetLostError : /cancelled|closed|aborted/
        );
        await stopping;
        assert.equal(sessions.length, mode === "retry-limit" ? 2 : 1);
        assert.deepEqual(platform.spawner.list(), []);
      }
      assert.equal(recoveries, 1, "one retry budget, not an unbounded reconnect loop");
      proxy.release();
    }
  );
}
