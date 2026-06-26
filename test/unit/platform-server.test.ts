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
  const boundPort = await srv.listen(port);
  return { port: boundPort, stop: () => srv.close() };
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
      {
        async handle() {
          return "";
        },
      },
      { singleConnection: true }
    );
    const boundPort = await srv.listen(port);
    return { port: boundPort, stop: () => srv.close() };
  };
  const sp = new GdbServerSpawner(capturingLauncher);
  const srv = new RspServer(
    new PlatformServer({
      spawner: sp,
      listTabs: async () => [{ actor: "tab-actor-1", url: "http://example.com/", title: "" }],
    })
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

test("concurrent qLaunchGDBServer for same tab returns identical pid/port", async () => {
  let launchCount = 0;
  const concurrentLauncher: GdbServerLauncher = async ({ port }) => {
    launchCount++;
    const srv = new RspServer({ async handle() { return ""; } }, { singleConnection: true });
    const boundPort = await srv.listen(port);
    return { port: boundPort, stop: () => srv.close() };
  };
  const sp = new GdbServerSpawner(concurrentLauncher);
  const ps = new PlatformServer({
    spawner: sp,
    listTabs: async () => [{ actor: "tab-concurrent", url: "http://example.com/", title: "" }],
  });
  const srv = new RspServer(ps);
  const srvPort = await srv.listen(0);
  const cl = await RspClient.connect(srvPort);

  // Get the tab's stable pid.
  const listResp = await cl.requestText("qfProcessInfo");
  const pid = listResp.match(/pid:(\d+);/)![1];

  // Fire two concurrent qLaunchGDBServer requests for the same tab.
  const [r1, r2] = await Promise.all([
    cl.requestText(`qLaunchGDBServer;host:localhost;pid:${pid};`),
    cl.requestText(`qLaunchGDBServer;host:localhost;pid:${pid};`),
  ]);

  // Both responses must resolve to the same spawned server.
  const port1 = r1.match(/pid:(\d+);port:(\d+);/);
  const port2 = r2.match(/pid:(\d+);port:(\d+);/);
  assert.ok(port1, "first response has pid;port");
  assert.ok(port2, "second response has pid;port");
  assert.equal(port1![1], port2![1], "same spawner pid");
  assert.equal(port1![2], port2![2], "same port");

  // The underlying launcher should have been called exactly once.
  assert.equal(launchCount, 1, "launcher called once despite two concurrent requests");

  // Also verify wrapConnectPort is called once by using a PlatformServer with it.
  let wrapCount = 0;
  const spWrap = new GdbServerSpawner(concurrentLauncher);
  const psWrap = new PlatformServer({
    spawner: spWrap,
    listTabs: async () => [{ actor: "tab-wrap", url: "http://example.com/", title: "" }],
    wrapConnectPort: async (p) => { wrapCount++; return p + 10000; },
  });
  const srvWrap = new RspServer(psWrap);
  const portWrap = await srvWrap.listen(0);
  const clWrap = await RspClient.connect(portWrap);
  const listRespWrap = await clWrap.requestText("qfProcessInfo");
  const tabPidWrap = listRespWrap.match(/pid:(\d+);/)![1];
  const [rw1, rw2] = await Promise.all([
    clWrap.requestText(`qLaunchGDBServer;host:localhost;pid:${tabPidWrap};`),
    clWrap.requestText(`qLaunchGDBServer;host:localhost;pid:${tabPidWrap};`),
  ]);
  assert.equal(rw1.match(/port:(\d+);/)![1], rw2.match(/port:(\d+);/)![1], "same wrapped port");
  assert.equal(wrapCount, 1, "wrapConnectPort called once despite two concurrent requests");

  clWrap.close();
  await srvWrap.close();
  await spWrap.killAll();
  cl.close();
  await srv.close();
  await sp.killAll();
});

test("unsupported packets get an empty response", async () => {
  assert.equal(await client.requestText("vCont?"), "");
});
