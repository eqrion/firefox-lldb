/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { retrySessionSetup } from "./harness.mjs";

test("session setup retries with a fresh attempt after transient failures", async () => {
  let attempts = 0;
  const session = await retrySessionSetup(async () => {
    attempts++;
    if (attempts < 3) throw new Error(`transient failure ${attempts}`);
    return { attempt: attempts };
  });

  assert.deepEqual(session, { attempt: 3 });
});

test("session setup reports every failure after exhausting retries", async () => {
  await assert.rejects(
    retrySessionSetup(async () => {
      throw new Error("still wedged");
    }, 2),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.message, "session setup failed after 2 attempts");
      assert.equal(err.errors.length, 2);
      return true;
    }
  );
});
