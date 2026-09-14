/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A pause belongs to the target actor that reported it. If that target is
// replaced by another navigation before LLDB consumes the pause, every trace
// of the old pause must disappear with it. Otherwise the next continue tries
// to adopt a pause that no live thread owns and waits forever.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, continueUntilBreakpoint, sleep } from "./harness.mjs";

let s;
let requestedModule, releaseModule;
const moduleRequested = new Promise((resolve) => (requestedModule = resolve));
const moduleResponse = new Promise((resolve) => (releaseModule = resolve));

async function waitForTrace(pattern, message) {
  for (let i = 0; i < 400; i++) {
    if (pattern.test(readFileSync(s.transcriptPath(), "utf8"))) return;
    await sleep(25);
  }
  assert.fail(`${message}; transcript: ${s.transcriptPath()}`);
}
before(async () => {
  s = await Session.stoppedAtBreakpoint("navigation", {
    async transformResponse(rel, body) {
      if (rel === "math2.wasm") {
        requestedModule();
        await moduleResponse;
      }
      return body;
    },
  });
});
after(async () => {
  releaseModule();
  await s?.shutdown();
});

test("a second navigation discards an unwitnessed pause from the replaced target", async () => {
  const initialGeneration = s.topLevelGeneration();
  const stableTid = s.topLevelTid();
  await s.navigate(s.pageUrl("page2.html"));
  const page2Generation = s.topLevelGeneration();
  assert.ok(page2Generation > initialGeneration, "page 2 must be a new target generation");
  assert.equal(s.topLevelTid(), stableTid, "the top-level debugger tid stays stable");
  await sleep(3000);

  // LLDB is still stopped on page 1, so this page-2 breakpoint pause has no
  // armed all-stop listener and is recorded as unwitnessed.
  s.evaluate("runFactorial()");
  for (let i = 0; i < 50 && !s.hasUnwitnessedPause(); i++) await sleep(100);
  assert.equal(
    s.hasUnwitnessedPause(),
    true,
    "page 2 must pause before it is replaced to exercise the stale-pause path"
  );

  // page3 loads the same code from math2.wasm. The existing symbolic
  // breakpoint needs a library-change resync before it can bind there.
  await s.navigate(s.pageUrl("page3.html"));
  assert.ok(s.topLevelGeneration() > page2Generation, "page 3 must be a new target generation");
  assert.equal(s.topLevelTid(), stableTid, "the second replacement reuses the same tid");

  // The initial grace can expire while LLDB still retains the old stop. Its
  // resync intent must survive until the next execution wait is armed.
  await waitForTrace(
    new RegExp(`resync-deferred generation=${s.topLevelGeneration()} tid=${stableTid}`),
    "the target resync must be deferred while LLDB is idle"
  );
  const continued = continueUntilBreakpoint(s);
  // Observe rejection immediately while the test waits for the resync barrier.
  void continued.catch(() => {});
  await moduleRequested;
  // Do not release wasm until LLDB has consumed the empty library list and
  // resumed. This reproduces the CI ordering without a page-load sleep.
  await waitForTrace(
    /<library-list><\/library-list>[\s\S]*LLDB->TCP RSP \$vCont;c/,
    "LLDB must resync before the replacement wasm is available"
  );
  releaseModule();
  const trigger = setInterval(() => s.evaluate("runFactorial()"), 500);
  let st;
  try {
    st = await continued;
  } finally {
    clearInterval(trigger);
  }

  assert.equal(st.reason, "breakpoint");
  const f0 = await s.topFrame();
  assert.match(f0.function, /compute_factorial/);
});
