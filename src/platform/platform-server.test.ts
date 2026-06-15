import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { RspServer } from "../protocol/rsp-server.js";
import { RspClient } from "../test-utils/rsp-client.js";
import { LocalFileSystem } from "./filesystem.js";
import { GdbServerSpawner } from "./gdb-server-spawner.js";
import { DefaultProcessProvider } from "./process-provider.js";
import { PlatformServer } from "./platform-server.js";
import { asciiToHex, hexToAscii } from "../protocol/hex.js";
import { escapeBinary, unescapeBinary } from "../protocol/packet.js";

let server: RspServer;
let spawner: GdbServerSpawner;
let client: RspClient;
let tmpDir: string;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fxlldb-"));
  spawner = new GdbServerSpawner(() => ({
    async handle(payload) {
      return payload.toString("latin1").startsWith("qSupported") ? "PacketSize=4096" : "";
    },
  }));
  server = new RspServer(
    () =>
      new PlatformServer({
        fs: new LocalFileSystem(),
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
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test("QStartNoAckMode acknowledges", async () => {
  assert.equal(await client.requestText("QStartNoAckMode"), "OK");
});

test("qHostInfo reports a triple, endianness and pointer size", async () => {
  const resp = await client.requestText("qHostInfo");
  const fields = new Map(
    resp.split(";").filter(Boolean).map((kv) => {
      const i = kv.indexOf(":");
      return [kv.slice(0, i), kv.slice(i + 1)] as [string, string];
    })
  );
  assert.match(hexToAscii(fields.get("triple")!), /-/);
  assert.equal(fields.get("ptrsize"), "8");
  assert.ok(fields.get("endian") === "little" || fields.get("endian") === "big");
});

test("working directory round-trips through QSetWorkingDir/qGetWorkingDir", async () => {
  assert.equal(await client.requestText(`QSetWorkingDir:${asciiToHex(tmpDir)}`), "OK");
  assert.equal(hexToAscii(await client.requestText("qGetWorkingDir")), tmpDir);
});

test("vFile open/pwrite/pread/close round-trips file contents", async () => {
  const file = path.join(tmpDir, "hello.bin");
  // Bytes include the reserved escape bytes to exercise binary framing.
  const content = Uint8Array.from([0x00, 0x23, 0x24, 0x2a, 0x7d, 0x41, 0xff]);

  // WriteOnly | CanCreate | Truncate = 0x1 | 0x200 | 0x400 = 0x601
  const openResp = await client.requestText(
    `vFile:open:${asciiToHex(file)},${(0x601).toString(16)},${(0o644).toString(16)}`
  );
  assert.match(openResp, /^F[0-9a-f]+$/);
  const fd = parseInt(openResp.slice(1), 16);

  const writeReq = Buffer.concat([
    Buffer.from(`vFile:pwrite:${fd.toString(16)},0,`),
    Buffer.from(escapeBinary(content)),
  ]);
  const writeResp = await client.requestText(writeReq);
  assert.equal(parseInt(writeResp.slice(1), 16), content.length);
  await client.requestText(`vFile:close:${fd.toString(16)}`);

  // Verify on disk independently of our read path.
  assert.deepEqual(new Uint8Array(await fsp.readFile(file)), content);

  // Re-open read-only and pread it back.
  const ro = parseInt((await client.requestText(`vFile:open:${asciiToHex(file)},0,0`)).slice(1), 16);
  const readResp = await client.request(`vFile:pread:${ro.toString(16)},100,0`);
  const semi = readResp.indexOf(0x3b);
  const count = parseInt(readResp.subarray(1, semi).toString("latin1"), 16);
  const data = unescapeBinary(readResp.subarray(semi + 1));
  assert.equal(count, content.length);
  assert.deepEqual(data, content);
  await client.requestText(`vFile:close:${ro.toString(16)}`);
});

test("vFile:size and vFile:exists report file metadata", async () => {
  const file = path.join(tmpDir, "sized.txt");
  await fsp.writeFile(file, "abcd");
  assert.equal(parseInt((await client.requestText(`vFile:size:${asciiToHex(file)}`)).slice(1), 16), 4);
  assert.equal(await client.requestText(`vFile:exists:${asciiToHex(file)}`), "F,1");
  assert.equal(
    await client.requestText(`vFile:exists:${asciiToHex(path.join(tmpDir, "nope"))}`),
    "F,0"
  );
});

test("vFile:unlink removes a file", async () => {
  const file = path.join(tmpDir, "doomed.txt");
  await fsp.writeFile(file, "x");
  assert.equal(await client.requestText(`vFile:unlink:${asciiToHex(file)}`), "F0");
  assert.equal(await client.requestText(`vFile:exists:${asciiToHex(file)}`), "F,0");
});

test("qPlatform_mkdir creates a directory", async () => {
  const dir = path.join(tmpDir, "newdir");
  assert.equal(await client.requestText(`qPlatform_mkdir:${(0o755).toString(16)},${asciiToHex(dir)}`), "F0");
  assert.ok((await fsp.stat(dir)).isDirectory());
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
