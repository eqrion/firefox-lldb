/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { componentForModuleUrl, parseComponentRoutes } from "../../src/source-debugger/config.js";

test("component routes default to one catch-all LLDB", () => {
  assert.deepEqual(parseComponentRoutes([]), [{ id: "lldb", urlSubstring: "*" }]);
});

test("component routes select exact substring matches before the fallback", () => {
  const routes = parseComponentRoutes(["cpp=language=cpp", "dart=language=dart", "other=*"]);
  assert.equal(
    componentForModuleUrl(routes, "https://example.test/a.wasm?language=dart").id,
    "dart"
  );
  assert.equal(componentForModuleUrl(routes, "https://example.test/a.wasm").id, "other");
});

test("component routes reject malformed, duplicate, and ambiguous configuration", () => {
  assert.throws(() => parseComponentRoutes(["missing-pattern="]), /expected ID=URL_SUBSTRING/);
  assert.throws(() => parseComponentRoutes(["a=one", "a=two"]), /ids must be unique/);
  const routes = parseComponentRoutes(["a=wasm", "b=example"]);
  assert.throws(
    () => componentForModuleUrl(routes, "https://example.test/a.wasm"),
    /matches multiple components/
  );
  assert.throws(
    () => componentForModuleUrl(routes, "https://elsewhere.test/a.bin"),
    /no SourceDebuggerComponent owns/
  );
});
