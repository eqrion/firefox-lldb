/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression coverage for issue #35. These commands tear down or replace
// LLDB's live process and its background pthreads. lldb-wasm 0.1.2 used to
// deliver a stale Emscripten cleanup notification afterward, crashing Node at
// returnWorkerToPool(undefined). The bad-PID case also reached vAttach without
// the requested PID ever appearing in qLaunchGDBServer, so the bridge accepted
// PID 999 as though it were the real tab.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { LLDB_FAILED_STATUS, Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.attach("factorial");
});
after(async () => {
  await s?.shutdown();
});

test("detach, invalid attach, and remote platform commands do not crash LLDB", async () => {
  const detached = await s.command("process detach");
  assert.ok(detached.status < LLDB_FAILED_STATUS, detached.error);
  assert.match((await s.command("version")).output, /lldb version/);

  const reattached = await s.command("process attach --plugin wasm --pid 1");
  assert.ok(reattached.status < LLDB_FAILED_STATUS, reattached.error);

  const invalid = await s.command("process attach --plugin wasm --pid 999");
  assert.ok(invalid.status >= LLDB_FAILED_STATUS, "an unknown tab PID must fail to attach");
  assert.match(invalid.error, /attach failed/i);
  assert.doesNotMatch(invalid.output, /Process 999 stopped/);
  assert.match((await s.command("version")).output, /lldb version/);

  const selected = await s.command("platform select remote-gdb-server");
  assert.ok(selected.status < LLDB_FAILED_STATUS, selected.error);
  const status = await s.command("platform status");
  assert.match(status.output, /Connected: yes/i);
  const processes = await s.command("platform process list");
  assert.match(processes.output, /1 matching process|index\.html/i);
  assert.match((await s.command("version")).output, /lldb version/);
});
