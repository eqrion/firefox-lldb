/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, continueUntilBreakpoint } from "./harness.mjs";

test("Rust resource drops keep repeated stop inspection handles bounded", async (t) => {
  const session = await Session.attach("factorial");
  t.after(() => session.shutdown());
  await session.breakpointByName("factorial");
  for (let stop = 0; stop < 6; stop++) {
    await continueUntilBreakpoint(session);
    assert.match((await session.command("frame variable n")).output, /n = \d+/);
  }
  const transcript = readFileSync(session.transcriptPath(), "utf8");
  assert.match(transcript, /WasmValue\.drop/);
  assert.match(transcript, /Instance\.drop/);
  assert.match(transcript, /Frame\.drop/);
  const snapshots = transcript
    .split("\n")
    .filter((line) => line.includes("[debuggee] stop-snapshot "))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  assert.ok(snapshots.length >= 7);
  for (const snapshot of snapshots.slice(1)) {
    assert.equal(snapshot.valueHandles, 0, "locals must be released before the next stop");
    assert.equal(snapshot.instanceHandles, 0, "temporary instance handles must be released");
  }
});
