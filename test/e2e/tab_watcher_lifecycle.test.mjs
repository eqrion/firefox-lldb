/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken, watchAndPrimeFirefoxTabs } from "../../src/rdp/browser.ts";
import { RdpClient, RdpRequestError } from "../../src/rdp/client.ts";
import { withRdpStartupRetry } from "../../src/rdp/startup.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { tracingLogger } from "./harness.mjs";

async function browser(t) {
  const trace = tracingLogger();
  const port = await freePort();
  const firefox = await launchFirefox({
    rdpPort: port,
    headless: true,
    logger: trace,
    binary: process.env.FIREFOX_BINARY,
  });
  t.after(async () => {
    await firefox.close();
    trace.close();
  });
  await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
  return { port, trace };
}

for (const mode of ["initial-query", "priming", "coalescing"]) {
  test(`real tab watcher owns ${mode} through shutdown`, { timeout: 20_000 }, async (t) => {
    const { port, trace } = await browser(t);
    const abort = new AbortController();
    let hold = true;
    const requests = [];
    const gate = await packetGate(
      port,
      (_packet, method) => hold && method === (mode === "priming" ? "getWatcher" : "listTabs"),
      (packet) => requests.push(packet.type)
    );
    let watching;
    t.after(async () => {
      abort.abort();
      await gate.close();
      await watching;
    });
    let observations = 0;
    const primed = [];
    watching = watchAndPrimeFirefoxTabs(
      gate.port,
      "127.0.0.1",
      () => {
        observations++;
        if (mode === "initial-query") abort.abort();
      },
      {
        ...trace,
        debug(message) {
          trace.debug(message);
          if (message.includes("tab primed")) primed.push(message);
        },
      },
      abort.signal
    );
    await gate.held;
    if (mode === "coalescing") {
      for (let i = 0; i < 40; i++) gate.injectEvent({ from: "root", type: "tabListChanged" });
      await delay(30);
      assert.equal(
        requests.filter((method) => method === "listTabs").length,
        1,
        "one query owns the actor FIFO"
      );
      hold = false;
      gate.release();
      for (let i = 0; i < 100 && observations < 2; i++) await delay(10);
      assert.equal(observations, 2, "event burst becomes one follow-up query");
      assert.equal(primed.length, 1, "the same tab is primed only once");
      abort.abort();
    } else if (mode === "initial-query") {
      hold = false;
      gate.release();
    } else abort.abort();
    await watching;
    await gate.peersClosed();
    if (mode !== "coalescing") assert.equal(primed.length, 0, "shutdown prevents late priming");
  });
}

test(
  "RDP startup retries do not hide a real Firefox protocol error",
  { timeout: 20_000 },
  async (t) => {
    const { port, trace } = await browser(t);
    let attempts = 0;
    await assert.rejects(
      withRdpStartupRetry(async (signal) => {
        attempts++;
        const client = await RdpClient.connect(port, "127.0.0.1", { signal, logger: trace });
        try {
          await client.request("root", { type: "firefoxLldbUnknownMethod" });
        } finally {
          client.close();
        }
      }),
      RdpRequestError
    );
    assert.equal(attempts, 1);
  }
);

test("RDP startup deadline closes a withheld real greeting", { timeout: 20_000 }, async (t) => {
  const { port, trace } = await browser(t);
  const gate = await packetGate(port, (packet) => packet.from === "root" && packet.applicationType);
  t.after(() => gate.close());
  const rejected = assert.rejects(
    withRdpStartupRetry(
      (signal) => RdpClient.connect(gate.port, "127.0.0.1", { signal, logger: trace }),
      { timeoutMs: 250 }
    ),
    /startup timed out after 250 ms/
  );
  await gate.held;
  await rejected;
  await gate.peersClosed();
});
