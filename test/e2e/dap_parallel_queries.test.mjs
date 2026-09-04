/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP correlates parallel inspection, module, and console requests", async () => {
  session = await DAPFixtureSession.attach("factorial");
  assert.equal(session.initializeResponse.body.supportsModulesRequest, true);
  assert.equal(session.initializeResponse.body.supportsCompletionsRequest, true);

  const threadId = session.stoppedEvent.body.threadId;
  const stack = await session.requestOk("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 20,
  });
  const frame = stack.body.stackFrames[0];

  const requests = [
    ...Array.from({ length: 8 }, (_, index) =>
      session.request("evaluate", {
        expression: `n + ${index}`,
        frameId: frame.id,
        context: "watch",
      })
    ),
    session.request("threads"),
    session.request("modules", { startModule: 0, moduleCount: 20 }),
    session.request("stackTrace", { threadId, startFrame: 1, levels: 2 }),
    session.request("evaluate", {
      expression: "thread list",
      frameId: frame.id,
      context: "repl",
    }),
    session.request("completions", {
      text: "thread li",
      column: 10,
      frameId: frame.id,
    }),
  ];
  const responses = await Promise.all(requests);
  assert.ok(
    responses.every((response) => response.success),
    JSON.stringify(responses)
  );

  for (let index = 0; index < 8; index++) {
    assert.match(responses[index].body.result, new RegExp(String(10 + index)));
  }
  assert.ok(responses[8].body.threads.some((thread) => thread.id === threadId));
  // LLDB sees the synthetic wasm modules, but CreateModule currently omits
  // them from the DAP array because they have no compatible module ID.
  assert.ok(responses[9].body.totalModules > 0, JSON.stringify(responses[9]));
  assert.ok(Array.isArray(responses[9].body.modules));
  assert.equal(responses[10].body.stackFrames.length, 2);
  assert.match(responses[11].body.result, /thread #1|Process 1/);
  assert.ok(responses[12].body.targets.length > 0, JSON.stringify(responses[12]));
});
