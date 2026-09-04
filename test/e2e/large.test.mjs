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
import { findFirefoxBinary } from "../../src/rdp/firefox.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, "..", "fixtures", "large", "large.wasm");
const BUILT = existsSync(WASM);
const NIGHTLY =
  process.env.E2E_FIREFOX_CHANNEL === "nightly" || Boolean(findFirefoxBinary("nightly"));

let s;
before(async () => {
  if (!BUILT) return;
  // Loading SQLite's embedded sources transfers tens of megabytes over RSP.
  // That is continuous useful work, but it can legitimately exceed the
  // ordinary 30-second setup deadline on a loaded runner. Give this fixture
  // one longer attempt instead of restarting the entire transfer three times.
  s = await Session.attach("large", {
    channel: NIGHTLY ? "nightly" : "release",
    setupTimeoutMs: 120_000,
    setupAttempts: 1,
  });
});
after(async () => {
  await s?.shutdown();
});

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

test(
  "snapped breakpoints preserve stepping attribution and function arguments",
  {
    skip: !BUILT
      ? "large fixture not built"
      : !NIGHTLY
        ? "Firefox Nightly is not installed"
        : false,
  },
  async () => {
    const run = await s.breakpointByName("run_query");
    const line = await s.breakpointByLocation("large.cpp", 17);
    const sentinel = await s.breakpointByName("sqlite3VdbeExec");
    const lineId = Session.parseBreakpointId(line);
    assert.ok(Session.parseBreakpointId(run), `run_query breakpoint: ${run.output}`);
    assert.ok(lineId, `line breakpoint: ${line.output}`);
    assert.ok(Session.parseBreakpointId(sentinel), `sentinel breakpoint: ${sentinel.output}`);

    const first = await s.continue();
    assert.match(first.output, /stop reason = breakpoint 1\.1/, first.output);
    assert.match(first.output, /run_query/, first.output);
    assert.match(first.output, /large\.cpp:15/, first.output);

    const stepped = await s.stepInstruction();
    assert.match(stepped.output, /stop reason = breakpoint 2\.1/, stepped.output);
    assert.match(stepped.output, /large\.cpp:17/, stepped.output);

    const listed = await s.command("breakpoint list");
    assert.match(
      listed.output,
      /2: file = 'large\.cpp', line = 17,[\s\S]*?hit count = 1/,
      listed.output
    );

    await s.deleteBreakpoint(lineId);
    const afterDelete = await s.continue();
    assert.match(afterDelete.output, /stop reason = wasm step/, afterDelete.output);
    assert.doesNotMatch(afterDelete.output, /breakpoint 2\.1/, afterDelete.output);

    const atSentinel = await s.continue();
    assert.match(atSentinel.output, /stop reason = breakpoint 3\.1/, atSentinel.output);
    assert.match(atSentinel.output, /sqlite3VdbeExec/, atSentinel.output);

    const column = await s.breakpointByName("sqlite3_column_int");
    const columnId = Session.parseBreakpointId(column);
    assert.ok(columnId, `sqlite3_column_int breakpoint: ${column.output}`);
    const atColumn = await s.continue();
    assert.match(atColumn.output, /stop reason = breakpoint 4\.1/, atColumn.output);
    const pStmt = await s.variable(0, "pStmt");
    const i = await s.variable(0, "i");
    assert.equal(pStmt.valid, true);
    assert.notEqual(pStmt.unsigned, 0);
    assert.equal(i.valid, true);
    assert.equal(i.signed, 0);
  }
);
