/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { tracingLogger } from "./harness.mjs";

for (const mode of ["destroy-before-available", "source-limit"]) {
  test(`real RDP catalog rejects ${mode}`, { timeout: 20_000 }, async (t) => {
    const trace = tracingLogger();
    let ignored;
    const retired = new Promise((resolve) => {
      ignored = resolve;
    });
    const logger = {
      ...trace,
      debug(message) {
        trace.debug(message);
        if (message.includes("retired-actor-ignored")) ignored();
      },
    };
    const port = await freePort();
    let firefox, proxy, session;
    t.after(async () => {
      session?.close();
      await proxy?.close();
      await firefox?.close();
      trace.close();
    });
    firefox = await launchFirefox({
      rdpPort: port,
      headless: true,
      binary: process.env.FIREFOX_BINARY,
      logger,
    });
    await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
    let target;
    proxy = await packetGate(port, (packet) => {
      if (packet.type !== "target-available-form") return false;
      target = packet;
      return mode === "destroy-before-available";
    });
    session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, logger);
    if (mode === "destroy-before-available") {
      await proxy.held;
      proxy.injectEvent({
        from: target.from,
        type: "target-destroyed-form",
        target: target.target,
      });
      proxy.release();
      await retired;
      assert.deepEqual(
        session.listTids(),
        [],
        "a late arrival cannot resurrect its destroyed actor"
      );
    } else {
      await session.waitForTopLevelTarget();
      const closed = once(session, "close");
      proxy.injectEvent({
        from: target.target.actor,
        type: "resources-available-array",
        array: [
          [
            "source",
            Array.from({ length: 16385 }, (_, i) => ({
              actor: `fault-source-${i}`,
              url: `http://example.invalid/${i}.js`,
              introductionType: "script",
            })),
          ],
        ],
      });
      await closed;
      assert.match(trace.tail().join("\n"), /source actor limit exceeded/);
      await proxy.peersClosed();
    }
  });
}
