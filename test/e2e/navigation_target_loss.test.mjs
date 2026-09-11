/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { RdpWasmSession, NavigationTargetLostError } from "../../src/rdp/session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { startStaticServer, tracingLogger } from "./harness.mjs";

test(
  "accepted navigation without a replacement target fails visibly and releases its waiters",
  {
    timeout: 25_000,
  },
  async (t) => {
    const trace = tracingLogger();
    const fixture = await startStaticServer("test/fixtures/threaded");
    const url = `http://127.0.0.1:${fixture.port}/index.html`;
    const port = await freePort();
    let firefox, proxy, session;
    let withholding = true;
    const heldActors = new Set();
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
    proxy = await packetGate(port, (packet) => {
      if (!withholding) return false;
      if (packet.type === "target-available-form" && packet.target?.url !== "about:blank") {
        heldActors.add(packet.target.actor);
        return true;
      }
      return heldActors.has(packet.from);
    });
    session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, trace);
    await session.waitForTopLevelTarget();
    const rejected = assert.rejects(session.navigate(url), NavigationTargetLostError);
    await proxy.held;
    await rejected;
    assert.equal(session.topLevelGeneration(), 0, "a loaded tab is not an observed debug target");
    assert.equal(session.listenerCount("lifecycle-state"), 0);
    assert.equal(session.listenerCount("paused"), 0);
    trace.flush();
    const log = readFileSync(trace.logPath, "utf8");
    assert.match(log, /navigation.request-replied/);
    assert.match(log, /target.top-level-gone/);
    assert.match(log, /navigation.failed/);
    assert.doesNotMatch(log, /navigation.complete /);
    // A late real announcement may restore observation, but cannot turn the
    // already-failed operation into success or satisfy a later navigation.
    withholding = false;
    proxy.release();
    await session.waitForTopLevelTarget();
    await session.navigate(url);
    assert.ok(session.topLevelGeneration() > 1);
  }
);

test(
  "navigation accepts a real replacement announced after the detach grace",
  { timeout: 20_000 },
  async (t) => {
    const trace = tracingLogger();
    const fixture = await startStaticServer("test/fixtures/simple");
    const port = await freePort();
    let firefox, proxy, session;
    let holding = true;
    const heldActors = new Set();
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
    proxy = await packetGate(port, (packet) => {
      if (!holding) return false;
      if (packet.type === "target-available-form" && packet.target?.url !== "about:blank") {
        heldActors.add(packet.target.actor);
        return true;
      }
      return heldActors.has(packet.from);
    });
    session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, trace);
    await session.waitForTopLevelTarget();
    const detached = once(session, "detached");
    const navigating = session.navigate(`http://127.0.0.1:${fixture.port}/index.html`);
    let settled = false;
    void navigating.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.all([proxy.held, detached]);
    await delay(20);
    assert.equal(settled, false, "detach grace cannot decide navigation completion");
    holding = false;
    proxy.release();
    await navigating;
    assert.ok(session.topLevelGeneration() > 1);
    assert.equal(session.listenerCount("lifecycle-state"), 0);
  }
);

test(
  "late navigation acceptance cannot publish a destination that was replaced again",
  { timeout: 20_000 },
  async (t) => {
    const trace = tracingLogger();
    let destinationReady;
    const ready = new Promise((resolve) => {
      destinationReady = resolve;
    });
    const logger = {
      ...trace,
      debug(message) {
        trace.debug(message);
        if (message.includes("navigation.destination-ready")) destinationReady();
      },
    };
    const fixture = await startStaticServer("test/fixtures/simple");
    const url = `http://127.0.0.1:${fixture.port}/index.html`;
    const port = await freePort();
    let firefox, proxy, session;
    let holding = true;
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
      logger,
    });
    await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
    proxy = await packetGate(port, (_packet, request) => holding && request === "navigateTo");
    session = await RdpWasmSession.start(proxy.port, "127.0.0.1", undefined, logger);
    await session.waitForTopLevelTarget();
    const rejected = assert.rejects(session.navigate(url), /destination retired|lost target/);
    await ready;
    const replacement = once(session, "target");
    void session.evaluate(`location.href = ${JSON.stringify(url + "?second")}`).catch(() => {});
    await replacement;
    holding = false;
    proxy.release();
    await rejected;
    assert.equal(session.listenerCount("lifecycle-state"), 0);
    await session.navigate(url);
  }
);
