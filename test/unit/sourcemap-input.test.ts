/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSourceMapBytes, sourceMapDataUrlBytes } from "../../src/sourcemap/input.js";

test("sanitizeSourceMapBytes preserves indexes while relocating unsafe source names", () => {
  const input = new TextEncoder().encode(
    JSON.stringify({
      version: 3,
      sourceRoot: "../root",
      sources: ["math.cpp", "../../etc/passwd", "C:\\secret\\file.cpp"],
      sourcesContent: ["one", "two", "three"],
      names: [],
      mappings: "AAAA;AACA",
    })
  );
  const map = JSON.parse(new TextDecoder().decode(sanitizeSourceMapBytes(input)));
  assert.equal(map.sourceRoot, "");
  assert.equal(map.sources.length, 3);
  assert.deepEqual(map.sourcesContent, ["one", "two", "three"]);
  for (const source of map.sources) {
    assert.doesNotMatch(source, /(^[\\/]|\.\.|^[A-Za-z]:)/);
  }
});

test("sourceMapDataUrlBytes decodes base64 and percent-encoded maps", () => {
  const json = '{"version":3,"sources":[]}';
  assert.equal(
    new TextDecoder().decode(
      sourceMapDataUrlBytes(`data:application/json;base64,${Buffer.from(json).toString("base64")}`)
    ),
    json
  );
  assert.equal(
    new TextDecoder().decode(
      sourceMapDataUrlBytes(`data:application/json,${encodeURIComponent(json)}`)
    ),
    json
  );
});
