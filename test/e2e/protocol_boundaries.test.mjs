/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { framePacket } from "../../src/protocol/packet.ts";
import { RspClient } from "../unit/rsp-client.ts";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const mode of [
  "checksum",
  "frame-limit",
  "trace-bound",
  "wrap-rollback",
  "unavailable-module",
]) {
  test(`real component attach boundary rejects ${mode}`, { timeout: 25_000 }, async (t) => {
    const trace = tracingLogger();
    const records = [];
    const logger = {
      ...trace,
      debug(message) {
        records.push(message);
        trace.debug(message);
      },
      error(message) {
        records.push(message);
        trace.error(message);
      },
    };
    const fixture = await startStaticServer("test/fixtures/simple");
    let platform, rsp, platformRsp;
    let failWrap = mode === "wrap-rollback";
    t.after(async () => {
      rsp?.close();
      platformRsp?.close();
      await platform?.shutdown();
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
      trace.close();
    });
    platform = await startPlatformServer(
      parseCliArgs([
        "--launch",
        "--headless",
        "--port",
        "0",
        "--rdp-port",
        String(await freePort()),
        "--url",
        `http://127.0.0.1:${fixture.port}/index.html`,
        ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
      ]),
      {
        logger,
        onTab() {},
        onRdpSession(session) {
          if (mode !== "unavailable-module") return;
          const fetch = session.fetchModuleBytes.bind(session);
          session.fetchModuleBytes = () => fetch("wasm:deliberately-unavailable");
        },
        wrapConnectPort: async (port) => {
          if (failWrap) throw new Error("deliberate connect port failure");
          return port;
        },
      }
    );
    if (mode === "wrap-rollback") {
      platformRsp = await RspClient.connect(platform.port);
      assert.equal(await platformRsp.requestText("qLaunchGDBServer"), "E01");
      assert.deepEqual(
        platform.spawner.list(),
        [],
        "failed wrapper releases its real component and RDP session"
      );
      failWrap = false;
      assert.match(await platformRsp.requestText("qLaunchGDBServer"), /^pid:\d+;port:\d+;/);
      assert.equal(platform.spawner.list().length, 1);
      return;
    }
    const server = await platform.spawner.launch();
    rsp = await RspClient.connect(server.port);
    if (mode === "frame-limit") {
      const closed = once(rsp.socket, "close");
      rsp.socket.write(Buffer.concat([Buffer.from("$"), Buffer.alloc(64 * 1024 + 1, 65)]));
      await closed;
      return;
    }
    const bad = framePacket("vAttach;1");
    bad[bad.length - 1] = 122; // Non-hex checksum must not change attach state.
    const nacked = once(rsp.socket, "data");
    rsp.socket.write(bad);
    assert.equal((await nacked)[0].toString(), "-");
    assert.equal(
      await rsp.requestText("qProcessInfo"),
      "E01",
      "invalid attach did not reach the component"
    );
    assert.match(await rsp.requestText("vAttach;1"), /^[TS]/);
    assert.match(await rsp.requestText("qProcessInfo"), /pid:/);
    if (mode === "unavailable-module") {
      const libraries = await rsp.requestText("qXfer:libraries:read::0,ffff");
      const library = libraries.match(
        /<library name="math\.wasm[^>]*>.*?<section address="([^"]+)"/
      );
      assert.ok(library, libraries);
      const address = BigInt(library[1]).toString(16);
      assert.match(
        await rsp.requestText(`m${address},8`),
        /^E/,
        "missing module bytes must not become a valid empty wasm header"
      );
      assert.match(await rsp.requestText("qProcessInfo"), /pid:/);
      assert.match(records.join("\n"), /could not acquire valid module bytes/);
      return;
    }
    if (mode === "trace-bound") {
      const packet = "qUnknownTraceProbe:" + "x".repeat(3000);
      assert.equal(await rsp.requestText(packet), "");
      assert.match(await rsp.requestText("qProcessInfo"), /pid:/);
      const inbound = records.find((line) => line.includes("qUnknownTraceProbe:"));
      assert.ok(inbound, "component emits its inbound trace through the runtime logger");
      assert.match(inbound, /bytes=3023 omitted=1999 incomplete=false/);
      assert.ok(inbound.length < 1200, `bounded producer record: ${inbound.length}`);
    }
  });
}
