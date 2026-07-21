/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { report } from "./reporter.mjs";

test("verbose reporter routes diagnostics off the reporter output stream", async () => {
  async function* events() {
    yield { type: "test:stderr", data: { message: "large RSP diagnostic\n" } };
  }

  let diagnostics = "";
  let output = "";
  for await (const chunk of report(events(), {
    verbose: true,
    writeDiagnostic: (message) => {
      diagnostics += message;
    },
  })) {
    output += chunk;
  }

  assert.equal(diagnostics, "large RSP diagnostic\n");
  assert.doesNotMatch(output, /large RSP diagnostic/);
  assert.match(output, /0 passed/);
});
