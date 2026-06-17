/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { RspServer } from "../../src/protocol/rsp-server.js";
import { RspClient } from "./rsp-client.js";
import { GdbServerSpawner, type GdbServerLauncher } from "../../src/platform/gdb-server-spawner.js";
import { PlatformServer } from "../../src/platform/platform-server.js";
import { asciiToHex, hexToAscii } from "../../src/protocol/hex.js";
import type { TabInfo } from "../../src/rdp/session.js";

// Fake launcher: starts a trivial RspServer on the given port so
// qLaunchGDBServer tests can verify the spawned port is reachable.
const fakeLauncher: GdbServerLauncher = async ({ port }) => {
  const srv = new RspServer(
    {
      async handle(payload) {
        return payload.toString("latin1").startsWith("qSupported") ? "PacketSize=4096" : "";
      },
    },
    { singleConnection: true }
  );
  await srv.listen(port);
  return { stop: () => srv.close() };
};

const fakeTabs: TabInfo[] = [
  { actor: "server1.conn0.tab1", url: "http://localhost:8080/", title: "Test Page" },
];

let server: RspServer;
let spawner: GdbServerSpawner;
let client: RspClient;

before(async () => {
  spawner = new GdbServerSpawner(fakeLauncher);
  server = new RspServer(new PlatformServer({ spawner, listTabs: async () => fakeTabs }));
  const port = await server.listen(0);
  client = await RspClient.connect(port);
});

after(async () => {
  client.close();
  await spawner.killAll();
  await server.close();
});

test("QStartNoAckMode acknowledges", async () => {
  assert.equal(await client.requestText("QStartNoAckMode"), "OK");
});

test("qHostInfo reports a triple, endianness and pointer size", async () => {
  const resp = await client.requestText("qHostInfo");
  const fields = new Map(
    resp
      .split(";")
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf(":");
        return [kv.slice(0, i), kv.slice(i + 1)] as [string, string];
      })
  );
  assert.match(hexToAscii(fields.get("triple")!), /-/);
  assert.equal(fields.get("ptrsize"), "8");
  assert.ok(fields.get("endian") === "little" || fields.get("endian") === "big");
});

test("working directory round-trips through QSetWorkingDir/qGetWorkingDir", async () => {
  const dir = "/tmp/test-wd";
  assert.equal(await client.requestText(`QSetWorkingDir:${asciiToHex(dir)}`), "OK");
  assert.equal(hexToAscii(await client.requestText("qGetWorkingDir")), dir);
});

test("qfProcessInfo lists Firefox tabs as processes with hex-encoded urls", async () => {
  const resp = await client.requestText("qfProcessInfo");
  assert.match(resp, /pid:\d+;/);
  const name = resp.match(/name:([0-9a-f]+);/)![1];
  assert.equal(hexToAscii(name), "http://localhost:8080/");
  assert.equal(await client.requestText("qsProcessInfo"), "E04");
});

test("qfProcessInfo assigns stable pids across calls", async () => {
  const pid1 = (await client.requestText("qfProcessInfo")).match(/pid:(\d+);/)![1];
  const pid2 = (await client.requestText("qfProcessInfo")).match(/pid:(\d+);/)![1];
  assert.equal(pid1, pid2);
});

test("qLaunchGDBServer with pid routes to the correct tab actor", async () => {
  let capturedTabActor: string | undefined;
  const capturingLauncher: GdbServerLauncher = async ({ port, tabActor }) => {
    capturedTabActor = tabActor;
    const srv = new RspServer(
      { async handle() { return ""; } },
      { singleConnection: true },
    );
    await srv.listen(port);
    return { stop: () => srv.close() };
  };
  const sp = new GdbServerSpawner(capturingLauncher);
  const srv = new RspServer(
    new PlatformServer({
      spawner: sp,
      listTabs: async () => [{ actor: "tab-actor-1", url: "http://example.com/", title: "" }],
    }),
  );
  const srvPort = await srv.listen(0);
  const cl = await RspClient.connect(srvPort);

  const listResp = await cl.requestText("qfProcessInfo");
  const pid = listResp.match(/pid:(\d+);/)![1];

  const launchResp = await cl.requestText(`qLaunchGDBServer;host:localhost;pid:${pid};`);
  assert.match(launchResp, /port:\d+;/);
  assert.equal(capturedTabActor, "tab-actor-1");

  cl.close();
  await srv.close();
  await sp.killAll();
});

test("qLaunchGDBServer spawns a reachable per-tab GDB server", async () => {
  const resp = await client.requestText("qLaunchGDBServer:port:0;host:localhost;");
  const port = parseInt(resp.match(/port:(\d+);/)![1], 10);
  assert.ok(port > 0);

  // The spawned server should answer qSupported.
  const sub = await RspClient.connect(port);
  assert.equal(await sub.requestText("qSupported:xmlRegisters=i386"), "PacketSize=4096");
  sub.close();

  // And it shows up in the query list.
  const query = await client.requestText("qQueryGDBServer");
  assert.match(query, new RegExp(`"port":${port}`));
});

test("unsupported packets get an empty response", async () => {
  assert.equal(await client.requestText("vCont?"), "");
});
