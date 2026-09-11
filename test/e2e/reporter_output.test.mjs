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

test("quiet reporter preserves recovered setup and attach failures", async () => {
  const messages = [
    "[warn] [launch] reacquiring lost startup target tab=10\n",
    "[warn] [attach] failed attempt=1 targetReplaced=true\n",
    "[harness] session setup attempt 1/3 failed\n",
    "ordinary page output\n",
  ];
  async function* events() {
    for (const message of messages) yield { type: "test:stderr", data: { message } };
  }
  let diagnostics = "";
  for await (const _chunk of report(events(), {
    verbose: false,
    writeDiagnostic: (message) => {
      diagnostics += message;
    },
  })) {
    /* consume the reporter */
  }
  assert.equal(diagnostics, messages.slice(0, 3).join(""));
});
