import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { RspServer } from "../protocol/rsp-server.js";
import { RspClient } from "../test-utils/rsp-client.js";
import { GdbServerSpawner, type GdbServerLauncher } from "./gdb-server-spawner.js";
import { DefaultProcessProvider } from "./process-provider.js";
import { PlatformServer } from "./platform-server.js";
import { asciiToHex, hexToAscii } from "../protocol/hex.js";

// Fake launcher: starts a trivial RspServer on the given port so
// qLaunchGDBServer tests can verify the spawned port is reachable.
const fakeLauncher: GdbServerLauncher = async ({ port }) => {
  const srv = new RspServer(
    () => ({
      async handle(payload) {
        return payload.toString("latin1").startsWith("qSupported") ? "PacketSize=4096" : "";
      },
    }),
    { singleConnection: true }
  );
  await srv.listen(port);
  return { stop: () => srv.close() };
};

let server: RspServer;
let spawner: GdbServerSpawner;
let client: RspClient;

before(async () => {
  spawner = new GdbServerSpawner(fakeLauncher);
  server = new RspServer(
    () =>
      new PlatformServer({
        spawner,
        processes: new DefaultProcessProvider(),
      })
  );
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

test("qfProcessInfo lists at least one process with hex-encoded name", async () => {
  const resp = await client.requestText("qfProcessInfo");
  assert.match(resp, /pid:\d+;/);
  const name = resp.match(/name:([0-9a-f]+);/)![1];
  assert.equal(hexToAscii(name), "firefox-lldb");
  // The sole entry exhausts on the next query.
  assert.equal(await client.requestText("qsProcessInfo"), "E04");
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
