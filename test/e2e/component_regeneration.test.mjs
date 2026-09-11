/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("component regeneration patches are idempotent and fail closed on changed output", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdbstub-regeneration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src/gdb/generated"), { recursive: true });
  const script = join(dir, "scripts/patch-generated.mjs");
  copyFileSync("scripts/patch-generated.mjs", script);
  const file = join(dir, "src/gdb/generated/gdbstub.js");
  const generated = readFileSync("src/gdb/generated/gdbstub.js", "utf8");
  const unpatched = generated
    .replace("let currentSubtask; // jco-patch", "")
    .replace("this.#getComponentState().handles.remove(this.waitableRep()); // jco-patch", "");
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
  writeFileSync(file, unpatched);
  assert.equal(run().status, 0);
  const patched = readFileSync(file, "utf8");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(file, "utf8"), patched);
  for (const broken of [
    unpatched + "\nthis.#parentTask.removeSubtask(this);",
    unpatched.replace("this.#parentTask.removeSubtask(this);", ""),
  ]) {
    writeFileSync(file, broken);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected one anchor/);
    assert.equal(
      readFileSync(file, "utf8"),
      broken,
      "failed validation must not partially patch output"
    );
  }
});
