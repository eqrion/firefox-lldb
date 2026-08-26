/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox reports url:null for sources it has no URL for (confirmed here for
// `new Function` and `eval`). Such a source is dropped, since a breakpoint can
// only be addressed by URL, but dropping it must not disturb the page's real
// module: a null url reaching fetchModuleBytes used to throw on
// url.startsWith, and that throw crossed the SAB, was re-thrown uncaught in
// the gdbstub worker, and killed the whole session.
//
// See test/unit/session.test.ts for the precise wasm-source regression test.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.attach("anon_module");
});
after(async () => {
  await s?.shutdown();
});

test("URL-less sources do not stop the URL-backed module from being debugged", async () => {
  await s.breakpointByName("compute_factorial");
  await s.continue();
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
  assert.equal(f0.file?.endsWith("math.cpp"), true);
});
