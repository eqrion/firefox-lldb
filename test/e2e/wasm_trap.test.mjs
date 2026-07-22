/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wasm trap surface behaviour. With pauseOnExceptions + ignoreCaughtExceptions
// (see src/rdp/session.ts), an uncaught wasm trap pauses at the trapping frame
// and surfaces to LLDB as a SIGSEGV signal stop. The trapping frame stays
// inspectable, so we can read the locals that explain why it trapped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

// Attach to the trap fixture, fire the given entry point, and continue until the
// uncaught wasm trap pauses us. The fire expression runs on the first continue.
async function trapStop(fire) {
  const s = await Session.attach("trap", { fire });
  await s.continue();
  return s;
}

function assertTrapStop(st) {
  assert.equal(st.reason, "signal", `expected signal stop, got ${st.reason}`);
  if (st.signal_name !== undefined) assert.equal(st.signal_name, "SIGSEGV");
}

test("integer divide-by-zero traps; divisor is inspectable in the trapping frame", async () => {
  const s = await trapStop("runDivZero()");
  try {
    assertTrapStop(await s.state());
    assert.match((await s.topFrame()).function, /divide/);
    const a = await s.variable(0, "a");
    const b = await s.variable(0, "b");
    assert.equal(a.valid, true);
    assert.equal(b.valid, true);
    assert.equal(a.signed, 1);
    assert.equal(b.signed, 0); // why it trapped: the divisor is zero

    const frames = await s.frames();
    const jsFrames = frames.filter((frame) => frame.file?.endsWith(".js"));
    assert.ok(jsFrames.length > 0, "trap backtrace has at least one symbolicated JS caller");
    assert.ok(
      jsFrames.every((frame) => frame.line > 0),
      "every symbolicated JS caller has a source line"
    );
  } finally {
    await s.shutdown();
  }
});

test("unreachable instruction traps", async () => {
  const s = await trapStop("runUnreachable()");
  try {
    assertTrapStop(await s.state());
    assert.match((await s.topFrame()).function, /run_unreachable/);
  } finally {
    await s.shutdown();
  }
});

test("out-of-bounds load traps; bad pointer is inspectable", async () => {
  const s = await trapStop("runOob()");
  try {
    assertTrapStop(await s.state());
    assert.match((await s.topFrame()).function, /deref/);
    const p = await s.variable(0, "p");
    assert.equal(p.valid, true);
    assert.equal(p.unsigned, 0x7ffffff0);
  } finally {
    await s.shutdown();
  }
});

test("call_indirect signature mismatch traps", async () => {
  const s = await trapStop("runIndirect()");
  try {
    assertTrapStop(await s.state());
    assert.match((await s.topFrame()).function, /run_indirect/);
  } finally {
    await s.shutdown();
  }
});
