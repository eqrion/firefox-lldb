/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["short", "failure", "exit"]) {
  test(`production transcript handles ${mode} writes in a child process`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "session-log-io-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "session.log");
    const helper = fileURLToPath(new URL("../helpers/session-log-io-helper.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", helper, path, mode], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const contents = readFileSync(path, "utf8");
    if (mode === "exit") {
      assert.match(contents, /stderr\s+partial line at process exit/);
    } else {
      const result = JSON.parse(child.stdout);
      if (mode === "short") {
        assert.equal(result.failure, undefined);
        assert.ok(result.writes > 2);
        assert.match(contents, /non-ASCII survives short writes: π 🎯/);
        assert.match(contents, /tail survives disk failure/);
      } else {
        assert.match(result.failure, /ENOSPC/);
        assert.equal((child.stderr.match(/transcript incomplete/g) ?? []).length, 1);
        assert.match(result.report, /tail survives disk failure/);
        assert.match(result.report, /Session log incomplete/);
        assert.doesNotMatch(result.report, /Full session log/);
        assert.ok(contents.length > 0, "failed transcripts are kept even on clean-close removal");
      }
    }
  });
}
