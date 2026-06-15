import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checksum,
  framePacket,
  escapeBinary,
  unescapeBinary,
  PacketParser,
} from "./packet.js";

test("checksum is the byte sum modulo 256", () => {
  assert.equal(checksum(new TextEncoder().encode("OK")), (0x4f + 0x4b) & 0xff);
});

test("framePacket wraps payload with $...#<checksum>", () => {
  assert.equal(framePacket("OK").toString("latin1"), "$OK#9a");
});

test("binary escape round-trips the reserved bytes", () => {
  const raw = Uint8Array.from([0x00, 0x23, 0x24, 0x2a, 0x7d, 0xff, 0x41]);
  const escaped = escapeBinary(raw);
  // The four reserved bytes must each become a 2-byte escape sequence.
  assert.equal(escaped.length, raw.length + 4);
  assert.deepEqual(unescapeBinary(escaped), raw);
});

test("parser splits a stream into packets and ack markers", () => {
  const parser = new PacketParser();
  const items = parser.feed(Buffer.from("+$qHostInfo#00-\x03"));
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { type: "ack" });
  assert.equal(items[1].type, "packet");
  assert.equal((items[1] as { payload: Buffer }).payload.toString("latin1"), "qHostInfo");
  assert.deepEqual(items[2], { type: "nack" });
  assert.deepEqual(items[3], { type: "interrupt" });
});

test("parser buffers an incomplete packet until the rest arrives", () => {
  const parser = new PacketParser();
  assert.deepEqual(parser.feed(Buffer.from("$qHo")), []);
  const items = parser.feed(Buffer.from("stInfo#00"));
  assert.equal(items.length, 1);
  assert.equal((items[0] as { payload: Buffer }).payload.toString("latin1"), "qHostInfo");
});

test("parser flags a bad checksum", () => {
  const parser = new PacketParser();
  const [item] = parser.feed(Buffer.from("$OK#ff"));
  assert.equal(item.type, "packet");
  assert.equal((item as { valid: boolean }).valid, false);
});
