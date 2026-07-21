/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { containedSourcePath } from "../../src/sourcemap/materialize.js";

const ROOT = resolve("/tmp/firefox-lldb-test/module.src");

test("containedSourcePath keeps ordinary nested paths below the module directory", () => {
  assert.equal(containedSourcePath(ROOT, "src/lib/math.cpp"), resolve(ROOT, "src/lib/math.cpp"));
  assert.equal(containedSourcePath(ROOT, "./math.cpp"), resolve(ROOT, "math.cpp"));
});

test("containedSourcePath rejects source-map path traversal and absolute paths", () => {
  for (const path of [
    "../escape.cpp",
    "src/../../escape.cpp",
    "src\\..\\escape.cpp",
    "/tmp/escape.cpp",
    "C:\\tmp\\escape.cpp",
    "bad\0name.cpp",
  ]) {
    assert.equal(containedSourcePath(ROOT, path), null, path);
  }
});
