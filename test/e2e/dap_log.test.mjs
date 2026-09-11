/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAPFixtureSession } from "./dap-harness.mjs";

test("DAP transcripts correlate real requests, errors, and events without logging bodies", async (t) => {
  const session = await DAPFixtureSession.attach("factorial");
  t.after(() => session.shutdown());
  const threads = await session.requestOk("threads");
  const stack = await session.requestOk("stackTrace", { threadId: threads.body.threads[0].id });
  const invalid = await session.request("evaluate", {
    frameId: stack.body.stackFrames[0].id,
    expression: "private_expression_marker_that_does_not_exist",
    context: "watch",
  });
  assert.equal(invalid.success, false);
  await Promise.all([session.requestOk("threads"), session.requestOk("modules")]);
  assert.deepEqual(await session.shutdown(), { code: 0, signal: null }, session.stderr());

  const contents = readFileSync(session.logPath(), "utf8");
  const records = contents
    .split("\n")
    .filter((line) => line.includes("debug  [dap] "))
    .map((line) => JSON.parse(line.slice(line.indexOf("[dap] ") + 6)));
  const requests = records.filter((r) => r.type === "request");
  assert.ok(requests.some((r) => r.command === "initialize"));
  assert.ok(requests.some((r) => r.command === "attach"));
  for (const request of requests) {
    const response = records.find((r) => r.type === "response" && r.request_seq === request.seq);
    assert.ok(response, `missing response for ${JSON.stringify(request)}`);
    assert.equal(response.matchedRequest, true);
    assert.ok(response.durationMs >= 0);
  }
  assert.ok(
    records.some((r) => r.type === "response" && r.command === "evaluate" && r.success === false)
  );
  assert.ok(records.some((r) => r.type === "event" && r.name === "stopped"));
  const shutdown = records.find((r) => r.event === "shutdown");
  assert.equal(shutdown.pendingCount, 0);
  assert.equal(shutdown.correlationIncomplete, false);
  assert.doesNotMatch(JSON.stringify(records), /private_expression_marker|arguments|stackFrames/);
  assert.doesNotMatch(contents, /TCP->LLDB partial write|TCP->LLDB RSP \$W00#/);
  assert.doesNotMatch(session.stderr(), /\[dap\]/, "quiet diagnostics must not leak onto stdio");
});
