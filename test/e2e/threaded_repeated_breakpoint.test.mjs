/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression test for issue #7. Each stop happens at matmul_threaded's entry,
// before it dispatches work to Emscripten's idle pthread pool. Resuming must
// leave those workers able to accept the work so all three calls can reach the
// breakpoint instead of the second call hanging forever in pthread_join.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

test("pthread pool survives repeated breakpoint stop/resume cycles", async () => {
  const s = await Session.attach("threaded", {
    fire: "runMatmul();runMatmul();runMatmul()",
  });
  try {
    const breakpoint = await s.breakpointByName("matmul_threaded");
    const breakpointId = Session.parseBreakpointId(breakpoint);
    assert.notEqual(breakpointId, null, breakpoint.output);

    for (let hit = 1; hit <= 3; hit++) {
      await s.continue();
      const state = await s.state();
      assert.equal(state.reason, "breakpoint", `call ${hit} did not reach the breakpoint`);
      assert.match((await s.topFrame()).function, /matmul_threaded/);
    }

    const list = await s.command(`breakpoint list ${breakpointId}`);
    assert.match(list.output, /hit count = 3/);
  } finally {
    await s.shutdown();
  }
});
