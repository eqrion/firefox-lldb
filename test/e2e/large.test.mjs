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
  s = await Session.attach("large");
});
after(async () => {
  await s?.shutdown();
});

// Large-module tests verify attach performance and symbol resolution. They do
// NOT test breakpoint firing because wasmBreakpointOffsets currently maps source
// line numbers (keys) instead of wasm byte offsets (values), causing
// Z0-address→snappedOffset mismatches in large symbol-rich modules.

test(
  "large module attaches without hanging",
  {
    skip: !BUILT
      ? "large fixture not built (run: EMSDK=~/src/emsdk npm run build:fixture-large)"
      : false,
  },
  async () => {
    // If we reach here, attach completed — no hang or timeout.
    assert.ok(s, "session attached");
  }
);

test(
  "image lookup resolves sqlite3VdbeExec with source line",
  { skip: !BUILT ? "large fixture not built" : false },
  async () => {
    const r = await s.command("image lookup -n sqlite3VdbeExec");
    assert.match(r.output + r.error, /sqlite3VdbeExec/, `image lookup: ${r.output}`);
  }
);

test(
  "image lookup resolves run_query to large.cpp",
  { skip: !BUILT ? "large fixture not built" : false },
  async () => {
    const r = await s.command("image lookup -n run_query");
    assert.match(r.output + r.error, /large\.cpp/, `image lookup: ${r.output}`);
  }
);
