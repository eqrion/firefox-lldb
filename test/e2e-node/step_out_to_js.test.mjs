/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stepping out of the outermost wasm frame eventually reaches a JS caller.
// Ported from test/e2e/test_control_flow.py (test_step_out_to_js).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip = process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
  ? false
  : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => { if (!skip) s = await Session.attach("factorial"); });
after(async () => { await s?.shutdown(); });

test("StepOut from outermost wasm frame eventually reaches a JS caller", { skip }, async () => {
  await s.breakpointByName("compute_factorial");
  await s.continue();
  assert.match((await s.topFrame()).function, /compute_factorial/);

  let reachedJs = false;
  for (let i = 0; i < 5; i++) {
    await s.stepOut();
    const st = await s.state();
    if (st.reason === "exited") break;
    const f0 = await s.topFrame();
    if (f0.file?.endsWith(".js")) {
      reachedJs = true;
      break;
    }
  }

  assert.ok(reachedJs, "never reached a JS frame after 5 StepOuts");
});
