/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SUPPORTED_FIREFOX_MAJOR,
  MIN_SUPPORTED_FIREFOX_MAJOR,
  firefoxCompatibilityError,
  parseFirefoxMajor,
} from "../../src/rdp/firefox-compatibility.js";

test("Firefox version parser accepts release, ESR, beta, and Nightly formats", () => {
  assert.equal(parseFirefoxMajor("154.0.1"), 154);
  assert.equal(parseFirefoxMajor("140.0.4esr"), 140);
  assert.equal(parseFirefoxMajor("155.0b9"), 155);
  assert.equal(parseFirefoxMajor("157.0a1"), 157);
  assert.equal(parseFirefoxMajor("unknown"), undefined);
});

test("Firefox compatibility range includes the tested ESR through Nightly", () => {
  assert.equal(
    firefoxCompatibilityError({
      version: `${MIN_SUPPORTED_FIREFOX_MAJOR}.0esr`,
      major: MIN_SUPPORTED_FIREFOX_MAJOR,
    }),
    undefined
  );
  assert.equal(
    firefoxCompatibilityError({
      version: `${MAX_SUPPORTED_FIREFOX_MAJOR}.0a1`,
      major: MAX_SUPPORTED_FIREFOX_MAJOR,
    }),
    undefined
  );
});

test("Firefox compatibility range rejects older and unvalidated newer versions", () => {
  assert.match(
    firefoxCompatibilityError({
      version: `${MIN_SUPPORTED_FIREFOX_MAJOR - 1}.0`,
      major: MIN_SUPPORTED_FIREFOX_MAJOR - 1,
    }) ?? "",
    /too old/
  );
  assert.match(
    firefoxCompatibilityError({
      version: `${MAX_SUPPORTED_FIREFOX_MAJOR + 1}.0a1`,
      major: MAX_SUPPORTED_FIREFOX_MAJOR + 1,
    }) ?? "",
    /newer than/
  );
});
