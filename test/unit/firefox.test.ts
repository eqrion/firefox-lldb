/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findFirefoxBinary } from "../../src/rdp/firefox.js";

test("findFirefoxBinary returns a string or undefined (never throws)", () => {
  let result: string | undefined;
  assert.doesNotThrow(() => {
    result = findFirefoxBinary();
  });
  assert.ok(
    result === undefined || typeof result === "string",
    `expected string or undefined, got ${typeof result}`
  );
});

test("findFirefoxBinary result, when present, is a non-empty path string", () => {
  const result = findFirefoxBinary();
  if (result !== undefined) {
    assert.ok(result.length > 0, "binary path should not be empty");
    assert.match(result, /firefox/i, "path should contain 'firefox'");
  }
});

for (const channel of ["beta", "nightly"] as const) {
  test(`findFirefoxBinary(${channel}) returns a string or undefined (never throws)`, () => {
    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = findFirefoxBinary(channel);
    });
    assert.ok(
      result === undefined || typeof result === "string",
      `expected string or undefined, got ${typeof result}`
    );
  });
}
