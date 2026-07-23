/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Ctrl-C must wait for Firefox's real paused events before completing the
// gdbstub stop. Four workers remain blocked in futex waits while a fifth
// executes wasm, so the debugger must select a usable worker stack from
// all-stop instead of reporting an empty preallocated pool thread.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";

test("Ctrl-C snapshots a live worker while peers are futex-blocked", async () => {
  const s = await ReplSession.attach("threaded", { fire: "runInterruptWorkers(4)" });
  try {
    const typing = s.type("continue");
    await s.waitFor("Process running.");
    await s.waitFor("interrupt-spin-ready");

    for (let i = 0; i < 50 && s.session.listTids().length < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(s.session.listTids().length >= 5, "interrupt workers were not discovered");

    s.interrupt();
    const out = await typing;
    assert.match(out, /\* thread #(?!1\b)\d+/);
    assert.match(out, /interrupt_spin_worker|emscripten_futex_wait|_do_futex_wait/);
    assert.doesNotMatch(out, /frame #0: 0x00000000/);
  } finally {
    await s.shutdown();
  }
});
