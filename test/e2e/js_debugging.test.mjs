/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// JS-source breakpoint and stepping tests. Ported from
// test/e2e-python/test_js_debugging.py. The fire expression fires a second runFactorial()
// via setTimeout so that the JS breakpoint can fire after the wasm one is deleted.
// State mutates (stepOver) so the step test is last.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session, withDeadline } from "./harness.mjs";

// math.js line 725 is the `assert(args.length <= nargs, ...)` inside the export
// wrapper closure, which runs on every wasm export call.
const JS_BP_FILE = "math.js";
const JS_BP_LINE = 725;

let s;
before(async () => {
  s = await Session.attach("factorial", {
    fire: "runFactorial(); setTimeout(runFactorial, 800)",
  });
  await withDeadline(
    s,
    (async () => {
      const bpRes = await s.breakpointByName("compute_factorial");
      await s.continue(); // stop at wasm bp (first runFactorial call)
      await s.breakpointByLocation(JS_BP_FILE, JS_BP_LINE);
      const bpId = Session.parseBreakpointId(bpRes);
      if (bpId != null) await s.deleteBreakpoint(bpId);
      await s.continue(); // proceed to JS bp on the second runFactorial call
    })(),
    30_000
  );
});
after(async () => {
  await s?.shutdown();
});

test("JS breakpoint fires: stopped in math.js at/near line 725", async () => {
  const st = await s.state();
  assert.equal(st.reason, "breakpoint", `stop reason: ${st.reason}`);
  const f0 = await s.topFrame();
  assert.equal(f0.file?.endsWith(JS_BP_FILE), true, `frame0 file: ${f0.file}`);
  assert.ok(f0.line >= JS_BP_LINE, `line ${f0.line} < requested ${JS_BP_LINE}`);
  assert.ok(f0.line - JS_BP_LINE <= 5, `line ${f0.line} too far from requested ${JS_BP_LINE}`);
});

test("thread step-over in a JS frame advances by one source line", async () => {
  const lineBefore = (await s.topFrame()).line;
  await s.stepOver();
  assert.notEqual((await s.state()).reason, "exited");
  const f0 = await s.topFrame();
  assert.equal(f0.file?.endsWith(JS_BP_FILE), true);
  assert.ok(f0.line > lineBefore, `line did not advance: ${lineBefore} -> ${f0.line}`);
  assert.ok(f0.line - lineBefore <= 5, `line jumped too far: ${lineBefore} -> ${f0.line}`);
});
