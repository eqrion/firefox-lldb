/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchFirefox } from "../../src/core/firefox.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const scenario of [
  "shared site",
  "remove during replay",
  "JS replay",
  "close during install",
]) {
  test(`real Firefox breakpoint reconciliation: ${scenario}`, { timeout: 25_000 }, async (t) => {
    const trace = tracingLogger();
    const fixture = await startStaticServer("test/fixtures/simple");
    const port = await freePort();
    const url = `http://127.0.0.1:${fixture.port}/index.html`;
    let firefox, proxy, session;
    let block = false;
    const requests = [];
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
      logger: trace,
      binary: process.env.FIREFOX_BINARY,
    });
    await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
    proxy = await packetGate(
      port,
      (_packet, request) =>
        block &&
        request ===
          (scenario === "close during install"
            ? "setBreakpoint"
            : "getBreakpointPositionsCompressed"),
      (packet) => requests.push(packet)
    );
    session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, trace);
    await session.waitForTopLevelTarget();
    await session.navigate(url);
    let module;
    for (let attempt = 0; attempt < 100 && !module; attempt++) {
      [module] = await session.wasmSources();
      if (!module) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(module, "fixture module must be observed by Firefox");
    const offsets = await session.wasmBreakpointOffsets(module.actor);
    const pc = offsets.find((offset, index) => offsets[index + 1] - offset > 2);
    assert.ok(pc);

    if (scenario === "close during install") {
      block = true;
      const rejected = assert.rejects(session.setWasmBreakpoint(module.url, pc));
      await proxy.held;
      session.close();
      await rejected;
      return;
    }

    if (scenario === "shared site") {
      assert.equal(await session.setWasmBreakpoint(module.url, pc), pc);
      assert.equal(await session.setWasmBreakpoint(module.url, pc + 1), pc);
      requests.length = 0;
      await session.removeWasmBreakpoint(module.url, pc);
      assert.equal(requests.filter((packet) => packet.type === "removeBreakpoint").length, 0);
      await session.removeWasmBreakpoint(module.url, pc + 1);
      const removed = requests.filter((packet) => packet.type === "removeBreakpoint");
      assert.equal(removed.length, 1);
      assert.equal(removed[0].location.line, pc);
      return;
    }

    if (scenario === "JS replay") {
      const source = (await session.jsSources()).find((source) => source.url.endsWith("/math.js"));
      assert.ok(source);
      const line = await session.setJsBreakpoint(source.url, 725);
      requests.length = 0;
      await session.navigate(url);
      // A sources roundtrip drives the same event-fed reconciliation and joins
      // the removal queue; the installed replay must be removed at its snapped site.
      await session.jsSources();
      await session.removeJsBreakpoint(source.url, 725);
      const replay = requests.find(
        (packet) => packet.type === "setBreakpoint" && packet.location.sourceUrl === source.url
      );
      assert.ok(replay, "JS desired state must survive navigation");
      assert.equal(replay.location.line, line);
      assert.ok(
        requests.some(
          (packet) => packet.type === "removeBreakpoint" && packet.location.line === line
        )
      );
      return;
    }

    await session.setWasmBreakpoint(module.url, pc);
    requests.length = 0;
    block = true;
    const navigating = session.navigate(url);
    void navigating.catch(() => {});
    await proxy.held;
    const removing = session.removeWasmBreakpoint(module.url, pc);
    block = false;
    proxy.release();
    await Promise.all([navigating, removing]);
    assert.equal(
      requests.filter((packet) => packet.type === "setBreakpoint").length,
      0,
      "a late snap result must not reinstall deleted desired state"
    );
  });
}
