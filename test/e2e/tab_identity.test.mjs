/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchFirefox } from "../../src/core/firefox.ts";
import { RdpClient } from "../../src/rdp/client.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import {
  listFirefoxTabs,
  MissingTabError,
  verifyFirefoxLaunchToken,
} from "../../src/rdp/browser.ts";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { RspClient } from "../unit/rsp-client.ts";
import { startStaticServer, tracingLogger } from "./harness.mjs";

test(
  "tab identity survives connection changes and removal of an earlier tab",
  { timeout: 30_000 },
  async (t) => {
    const trace = tracingLogger();
    const fixture = await startStaticServer("test/fixtures/simple");
    const port = await freePort();
    const url = `http://127.0.0.1:${fixture.port}/index.html`;
    let firefox, control, first, platform, selected, rsp;
    t.after(async () => {
      rsp?.close();
      first?.close();
      control?.close();
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
    control = await RdpClient.connect(port, "127.0.0.1", { logger: trace });
    const root = await control.request("root", { type: "getRoot" });
    // These preferences affect only this test's throwaway Firefox profile.
    await control.request(root.preferenceActor, {
      type: "setBoolPref",
      name: "dom.disable_open_during_load",
      value: false,
    });
    first = await RdpWasmSession.start(port, "127.0.0.1", undefined, trace);
    await first.waitForTopLevelTarget();
    await first.navigate(`${url}?first`);
    assert.equal(
      (
        await first.evalJS(
          `globalThis.second = window.open(${JSON.stringify(`${url}?second`)}, "second"); Boolean(second)`
        )
      ).result,
      true
    );
    assert.equal(
      (
        await first.evalJS(
          `globalThis.third = window.open(${JSON.stringify(`${url}?third`)}, "third"); Boolean(third)`
        )
      ).result,
      true
    );
    const tabsWhen = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const tabs = await listFirefoxTabs(port);
        if (predicate(tabs)) return tabs;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Firefox tab list did not reach the expected state");
    };
    const before = await tabsWhen(
      (tabs) => tabs.length === 3 && tabs.every((tab) => tab.url.startsWith(url))
    );
    const second = before.find((tab) => tab.url.endsWith("?second"));
    const third = before.find((tab) => tab.url.endsWith("?third"));
    assert.ok(second && third);
    assert.deepEqual(
      (await listFirefoxTabs(port)).map((tab) => tab.id),
      before.map((tab) => tab.id)
    );
    await first.evalJS("second.close()");
    await tabsWhen((tabs) => tabs.length === 2 && !tabs.some((tab) => tab.id === second.id));
    await assert.rejects(
      RdpWasmSession.start(port, "127.0.0.1", second.id, trace),
      MissingTabError
    );

    platform = await startPlatformServer(
      parseCliArgs(["--connect", "--port", "0", "--rdp-port", String(port)]),
      {
        logger: trace,
        onTab() {},
        onSession(session) {
          selected = session;
        },
      }
    );
    const server = await platform.spawner.launch(0, `${url}?third`, third.id);
    assert.equal(selected.tabId, third.id);
    assert.equal(selected.topLevelUrl(), `${url}?third`);
    const wrongPid = platform.platformServer.tabPid(first.tabId);
    const selectedPid = platform.platformServer.tabPid(third.id);
    rsp = await RspClient.connect(server.port);
    assert.equal(await rsp.requestText(`vAttach;${wrongPid.toString(16)}`), "E01");
    assert.match(await rsp.requestText(`vAttach;${selectedPid.toString(16)}`), /^[TS]/);
  }
);
