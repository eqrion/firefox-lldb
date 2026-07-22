/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression test for issue #44: expression evaluation used to write an
// IRMemoryMap assertion directly to stderr while looking for scratch memory
// after successfully dereferencing the pointer. Run the attached session in a
// child process so the test can assert on that process-wide diagnostic stream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Session } from "./harness.mjs";

const CHILD_ENV = "FIREFOX_LLDB_EXPRESSION_POINTER_DEREF_CHILD";

if (process.env[CHILD_ENV]) {
  let s;
  try {
    s = await Session.stoppedAtBreakpoint("types");
    const up = await s.command("up");
    assert.equal(up.status < 6, true, up.error);

    const result = await s.command("p *p");
    assert.equal(result.status < 6, true, result.error);
    assert.match(result.output, /\(int32_t\) -42/);
  } finally {
    await s?.shutdown();
  }
} else {
  test("pointer dereference expression does not emit an IRMemoryMap assertion", async () => {
    const run = promisify(execFile);
    const { stderr } = await run(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, [CHILD_ENV]: "1" },
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      }
    );
    assert.doesNotMatch(stderr, /Assertion failed|IRMemoryMap/);
  });
}
