/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const method of ["source", "substring", "slice"]) {
  test(
    `navigation cancels a held real ${method} reply without poisoning replacement actors`,
    { timeout: 20_000 },
    async (t) => {
      const trace = tracingLogger();
      const fixture = await startStaticServer("test/fixtures/simple");
      const url = `http://127.0.0.1:${fixture.port}/index.html`;
      const port = await freePort();
      let firefox,
        proxy,
        session,
        holding = false;
      t.after(async () => {
        session?.close();
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
      proxy = await packetGate(port, (_packet, request) => holding && request === method);
      session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, trace);
      await session.waitForTopLevelTarget();
      await session.navigate(url);
      let source;
      for (let attempt = 0; attempt < 100 && !source; attempt++) {
        const sources =
          method === "slice" ? await session.wasmSources() : await session.jsSources();
        source = sources.find((value) => method === "slice" || value.url.endsWith("/math.js"));
        if (!source) await delay(20);
      }
      assert.ok(source);
      holding = true;
      const pending =
        method === "slice"
          ? session.fetchModuleBytes(source.url)
          : session.fetchSourceText(source.actor);
      const rejected = assert.rejects(pending, /retired/);
      await proxy.held;
      await session.navigate(url);
      await rejected;
      holding = false;
      proxy.release();
      // A late reply belongs to its retired FIFO, never to the new generation.
      assert.ok((await session.jsSources()).length > 0);
      assert.match(trace.tail().join("\n"), /actor-retired|retired-actor-packet/);
    }
  );
}
