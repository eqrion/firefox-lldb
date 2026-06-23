/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Infrastructure smoke test (no Firefox required): drives the embedded wasm
// LLDB through the off-worker session API and the in-process transport bridge,
// confirming the platform connection completes and structured queries work.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let session;
before(async () => {
  session = await Session.platformOnly();
});
after(async () => {
  await session?.shutdown();
});

test("platform connection is live (host info available)", async () => {
  const res = await session.command("platform status");
  assert.match(res.output, /wasm/i);
  assert.match(res.output, /Connected: yes/i);
});

test("version command returns an lldb version", async () => {
  const res = await session.command("version");
  assert.match(res.output, /lldb version|lldb-\d/);
});

test("state is 'none' before any process is attached", async () => {
  const st = await session.state();
  assert.equal(st.reason, "none");
});
