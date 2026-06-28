/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Edge case and boundary behaviour tests. Ported from
// test/e2e-python/test_edge_cases.py. Both tests share one stopped session (factorial
// stopped at compute_factorial).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("factorial");
});
after(async () => {
  await s?.shutdown();
});

test("JS caller frames are visible above the wasm breakpoint frame", async () => {
  const frames = await s.frames();
  const f0 = frames[0];
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);

  const jsFrameIdx = frames.findIndex((f) => f.file?.endsWith(".js"));
  const frameFiles = frames.map((f) => f.file);
  assert.ok(
    jsFrameIdx > 0,
    `no JS frame found above the wasm frame; files: ${JSON.stringify(frameFiles)}`
  );
});

test("watchpoint attempt does not crash the session", async () => {
  // Watchpoints are not supported for wasm. The bridge should return an
  // invalid watchpoint or a clear error without crashing.
  const n = await s.variable(0, "n");
  assert.equal(n.valid, true);
  // Attempt via command; we just verify the process remains stopped.
  await s.command("watchpoint set variable n").catch(() => {});
  const st = await s.state();
  assert.notEqual(st.reason, "exited");
});
