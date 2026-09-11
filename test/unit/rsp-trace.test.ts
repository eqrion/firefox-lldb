/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RspTrace } from "../../src/diagnostics/rsp-trace.js";

test("RSP summaries handle fragmented, coalesced, and escaped packets", () => {
  const packets: string[] = [];
  const trace = new RspTrace((packet) => packets.push(packet));
  for (const chunk of ["+$E", "79#b", "5$binary}", "#tail#00"]) trace.feed(Buffer.from(chunk));
  assert.deepEqual(packets, ["$E79#b5", "$binary}#tail#00"]);
});

test("RSP summaries bound payload retention while reporting the full size", () => {
  const trace = new RspTrace(() => {});
  trace.feed(Buffer.from("$"));
  for (let i = 0; i < 1000; i++) trace.feed(Buffer.alloc(1000, 0x61));
  trace.feed(Buffer.from("#00"));
  assert.ok(trace.lastPacket.length < 200);
  assert.match(trace.lastPacket, /1000000 byte payload/);
});
