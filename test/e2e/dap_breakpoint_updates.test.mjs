/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

async function localValue(dap, stopped, name) {
  const stack = await dap.requestOk("stackTrace", {
    threadId: stopped.body.threadId,
    startFrame: 0,
    levels: 1,
  });
  const frame = stack.body.stackFrames[0];
  const scopes = await dap.requestOk("scopes", { frameId: frame.id });
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  const variables = await dap.requestOk("variables", {
    variablesReference: locals.variablesReference,
  });
  return variables.body.variables.find((variable) => variable.name === name)?.value;
}

test("DAP replaces breakpoints while stopped across recursive calls", async () => {
  session = await DAPFixtureSession.attach("factorial");

  const conditional = await session.requestOk("setFunctionBreakpoints", {
    breakpoints: [{ name: "factorial", condition: "n == 7" }],
  });
  assert.equal(conditional.body.breakpoints[0].verified, true, JSON.stringify(conditional));

  let stopped = await session.continueAndWait(session.stoppedEvent.body.threadId);
  assert.equal(await localValue(session, stopped, "n"), "7");

  await session.setFunctionBreakpoints([]);
  const source = await session.requestOk("setBreakpoints", {
    source: { name: "math.cpp", path: "math.cpp" },
    breakpoints: [{ line: 5, condition: "n == 5" }],
  });
  assert.equal(source.body.breakpoints[0].verified, true, JSON.stringify(source));

  stopped = await session.continueAndWait(stopped.body.threadId);
  assert.equal(await localValue(session, stopped, "n"), "5");
});
