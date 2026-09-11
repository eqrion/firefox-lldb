/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

test(
  "a module name containing an XML metacharacter reaches LLDB intact",
  { timeout: 35_000 },
  async (t) => {
    const session = await Session.stoppedAtBreakpoint("factorial", {
      setupAttempts: 1,
      mapPath: (path) => path.replace("math&debug.wasm", "math.wasm"),
      transformResponse(path, bytes) {
        return path === "math.js"
          ? Buffer.from(bytes.toString().replaceAll("math.wasm", "math&debug.wasm"))
          : bytes;
      },
    });
    t.after(() => session.shutdown());
    assert.match((await session.topFrame()).function, /compute_factorial/);
    assert.match((await session.command("image list")).output, /math&debug\.wasm/);
  }
);
