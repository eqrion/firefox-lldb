/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { retrySessionSetup, tracingLogger, withDeadline } from "./harness.mjs";

test("session setup retries with a fresh attempt after transient failures", async () => {
  let attempts = 0;
  const session = await retrySessionSetup(
    async () => {
      attempts++;
      if (attempts < 3)
        throw Object.assign(new Error(`transient failure ${attempts}`), { code: "ECONNRESET" });
      return { attempt: attempts };
    },
    3,
    { quiet: true }
  );

  assert.deepEqual(session, { attempt: 3 });
});

test("session setup reports every failure after exhausting retries", async () => {
  await assert.rejects(
    retrySessionSetup(
      async () => {
        throw Object.assign(new Error("still disconnected"), { code: "ECONNRESET" });
      },
      2,
      { quiet: true }
    ),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.message, "session setup failed after 2 attempts");
      assert.equal(err.errors.length, 2);
      return true;
    }
  );
});

test("session setup never retries assertions or unclassified failures", async () => {
  for (const error of [
    new Error("unexpected protocol reply"),
    new assert.AssertionError({ message: "wrong value" }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      retrySessionSetup(
        async () => {
          attempts++;
          throw error;
        },
        3,
        { quiet: true }
      ),
      /after 1 attempts/
    );
    assert.equal(attempts, 1);
  }
});

test("deadline diagnostics retain the full attempt, active stage, and cleanup outcome", async (t) => {
  const trace = tracingLogger();
  t.after(() => trace.close());
  trace.debug("first attempt diagnostic outside the recent tail");
  for (let i = 0; i < 30; i++) trace.debug(`packet ${i}`);
  trace.stage("submitting process attach attempt 1/4");
  trace.state("bridge tab-1", "channel=2 tcp=connected LLDB->TCP=0 chunks/0 bytes");
  const session = {
    forceKillFirefox() {},
    shutdown: async () => {},
    logState: (event) =>
      trace.debug(
        `[state] rdp.${event} {"current":{"closed":false,"activeGeneration":0,"threadCount":0}}`
      ),
  };

  await assert.rejects(withDeadline(session, new Promise(() => {}), 5, trace), (err) => {
    assert.match(err.message, /\[state\] setup: submitting process attach attempt 1\/4/);
    assert.match(err.message, /\[state\] bridge tab-1: channel=2 tcp=connected/);
    assert.match(err.message, /\[state\] rdp.deadline/);
    assert.match(err.message, /"activeGeneration":0/);
    assert.match(err.message, /cleanup: session shutdown completed/);
    assert.ok(err.message.includes(trace.logPath));
    const contents = readFileSync(trace.logPath, "utf8");
    assert.match(contents, /first attempt diagnostic outside the recent tail/);
    assert.match(contents, /session shutdown completed/);
    return true;
  });
});
