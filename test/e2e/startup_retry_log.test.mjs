/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { RspClient } from "../unit/rsp-client.ts";
import { DAPClient } from "./dap-harness.mjs";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const frontend of ["firefox-lldb", "firefox-lldb-dap", "firefox-lldb-server"]) {
  test(
    `${frontend} retains a recovered startup transcript after clean exit`,
    { timeout: 35_000 },
    async (t) => {
      const trace = tracingLogger();
      console.error(`[harness] intentional startup-target loss: ${frontend} log retention`);
      const fixture = await startStaticServer("test/fixtures/simple");
      const port = await freePort();
      let firefox, proxy, child, exited, rsp;
      t.after(async () => {
        rsp?.close();
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        await proxy?.close();
        await firefox?.close();
        fixture.server.closeAllConnections();
        await new Promise((resolve) => fixture.server.close(resolve));
        trace.close();
      });
      firefox = await launchFirefox({
        rdpPort: port,
        headless: true,
        binary: process.env.FIREFOX_BINARY,
        logger: trace,
      });
      await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
      let failedConnection;
      const heldActors = new Set();
      const prefix = (actor) => actor?.match(/^server\d+\.conn\d+\./)?.[0];
      proxy = await packetGate(
        port,
        (packet) => {
          if (
            packet.type === "target-available-form" &&
            failedConnection &&
            prefix(packet.from) === failedConnection
          ) {
            heldActors.add(packet.target.actor);
            return true;
          }
          return heldActors.has(packet.from);
        },
        (packet) => {
          if (packet.type === "navigateTo") failedConnection ??= prefix(packet.to);
        }
      );
      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          `src/cli/${frontend}.ts`,
          "--connect",
          "--port",
          "0",
          "--rdp-port",
          String(proxy.port),
          "--url",
          `http://127.0.0.1:${fixture.port}/index.html`,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: process.env, timeout: 25_000 }
      );
      exited = once(child, "exit");
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const waitFor = async (pattern) => {
        const deadline = performance.now() + 15_000;
        while (!pattern.test(output)) {
          assert.ok(
            child.exitCode === null && child.signalCode === null && performance.now() < deadline,
            output
          );
          await delay(20);
        }
      };
      if (frontend === "firefox-lldb-dap") {
        const dap = new DAPClient(child);
        assert.equal((await dap.request("initialize", { adapterID: "lldb" })).success, true);
        const attach = dap.request("attach", {
          attachCommands: ["process attach --plugin wasm --pid 1"],
        });
        void attach.catch(() => {});
        await dap.waitForEvent("initialized");
        assert.equal((await dap.request("configurationDone")).success, true);
        assert.equal((await attach).success, true, dap.stderr());
        child.kill("SIGTERM");
      } else if (frontend === "firefox-lldb-server") {
        await waitFor(/listening on 127\.0\.0\.1:\d+/);
        rsp = await RspClient.connect(Number(output.match(/listening on 127\.0\.0\.1:(\d+)/)[1]));
        assert.match(await rsp.requestText("qLaunchGDBServer"), /^pid:\d+;port:\d+;/);
        child.kill("SIGTERM");
      } else {
        await waitFor(/\(lldb\)/);
        child.stdin.write("quit\n");
      }
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null, output);
      assert.match(output, /reacquiring lost startup target/);
      const path = output.match(
        /Session transcript retained after (?:attach|startup) retry at (.+\.log)/
      )?.[1];
      assert.ok(path, output);
      const log = readFileSync(path, "utf8");
      assert.match(log, /navigation.failed/);
      assert.match(log, /reacquiring lost startup target/);
      assert.match(log, /\[launch\] stage=ready/);
    }
  );
}
