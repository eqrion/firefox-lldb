/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const finish of ["close", "timeout"]) {
  test(
    `withheld real worker pause ${finish} cannot publish partial all-stop`,
    { timeout: 25_000 },
    async (t) => {
      const trace = tracingLogger();
      const fixture = await startStaticServer("test/fixtures/threaded");
      const port = await freePort();
      let firefox, proxy, platform, session;
      let block = false;
      t.after(async () => {
        block = false;
        await proxy?.close();
        await platform?.shutdown();
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
      proxy = await packetGate(
        port,
        (packet) => block && packet.type === "paused" && /worker/i.test(packet.from)
      );
      platform = await startPlatformServer(
        parseCliArgs([
          "--connect",
          "--port",
          "0",
          "--rdp-port",
          String(proxy.port),
          "--url",
          `http://127.0.0.1:${fixture.port}/index.html`,
        ]),
        {
          logger: trace,
          onTab() {},
          onSession(value) {
            session = value;
          },
        }
      );
      await platform.spawner.launch();
      assert.ok(session.listTids().length > 1, "real pthread workers must participate");
      await session.resumeAll();
      block = true;
      const stopped = [];
      session.on("stopped", (event) => stopped.push(event));
      const operation = session.armAllStop();
      assert.equal(session.armAllStop(), operation, "repeated arm shares the same execution wait");
      const rejected = assert.rejects(
        operation.promise,
        finish === "close" ? /closed/ : /incomplete/
      );
      session.interrupt(session.topLevelTid());
      await proxy.held;
      if (finish === "close") session.close();
      await rejected;
      assert.equal(operation.pending, false);
      assert.deepEqual(stopped, [], "missing worker acknowledgement is not a stopped snapshot");
      assert.equal(session.listenerCount("lifecycle-state"), 0);
    }
  );
}
