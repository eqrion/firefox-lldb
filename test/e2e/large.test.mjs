/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Large-module (sqlite3) tests. Exercises attach performance and symbol
// resolution against a realistic, symbol-rich wasm binary.
//
// Requires the fixture to be built first:
//   EMSDK=~/src/emsdk npm run build:fixture-large

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Session } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, "..", "fixtures", "large", "large.wasm");
const BUILT = existsSync(WASM);

let s;
before(async () => {
  if (!BUILT) return;
  s = await Session.stoppedAtBreakpoint("large");
});
after(async () => {
  await s?.shutdown();
});

test(
  "attach and break at sqlite3_prepare_v2 (symbol-rich module)",
  {
    skip: !BUILT
      ? "large fixture not built (run: EMSDK=~/src/emsdk npm run build:fixture-large)"
      : false,
  },
  async () => {
    const f0 = await s.topFrame();
    assert.match(f0.function, /sqlite3_prepare/);
  }
);

test(
  "call stack through sqlite internals is symbolicated",
  { skip: !BUILT ? "large fixture not built" : false },
  async () => {
    const frames = await s.frames();
    assert.ok(frames.length >= 2, `expected >= 2 frames, got ${frames.length}`);
    assert.ok(
      frames.some((f) => /run_query|run_large/.test(f.function ?? "")),
      `expected run_query or run_large in stack; got: ${frames.map((f) => f.function).join(", ")}`
    );
  }
);

test(
  "locals inside sqlite3_prepare_v2 are readable (db pointer non-null)",
  { skip: !BUILT ? "large fixture not built" : false },
  async () => {
    const db = await s.variable(0, "db");
    assert.equal(db.valid, true);
    assert.notEqual(db.unsigned, 0);
  }
);
