/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Browser-owned bytes preserve credentials and the loaded module's identity.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

let s;
before(async () => {
  s = await Session.stoppedAtBreakpoint("auth_factorial");
});
after(async () => {
  await s?.shutdown();
});

test("browser-owned module bytes do not require an unauthenticated HTTP fetch", async () => {
  assert.equal(s.wasmFetchCount(), 0);
  const frame = await s.topFrame();
  assert.match(frame.function, /compute_factorial/);
  assert.match(frame.file, /math\.cpp$/);
});

test("a changed HTTP body cannot replace the browser-loaded module", async (t) => {
  const session = await Session.stoppedAtBreakpoint("factorial", {
    setupAttempts: 1,
    transformResponse(path, bytes, request) {
      return path.endsWith(".wasm") && request.headers["x-firefox-lldb"] === "module-fetch"
        ? Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
        : bytes;
    },
  });
  t.after(() => session.shutdown());
  assert.equal(session.wasmFetchCount(), 0);
  assert.match((await session.topFrame()).function, /compute_factorial/);
});
