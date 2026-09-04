/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP reports a wasm trap with exception metadata and an inspectable frame", async () => {
  session = await DAPFixtureSession.attach("trap", { configure: null });
  const stopped = session.stoppedEvent;
  assert.match(stopped.body.reason, /exception|signal/);
  assert.ok(stopped.body.threadId);

  const exception = await session.requestOk("exceptionInfo", {
    threadId: stopped.body.threadId,
  });
  assert.ok(exception.body.exceptionId);
  assert.ok(exception.body.breakMode);

  const stack = await session.requestOk("stackTrace", {
    threadId: stopped.body.threadId,
    startFrame: 0,
    levels: 20,
  });
  assert.match(stack.body.stackFrames[0].name, /divide/);
  const scopes = await session.requestOk("scopes", { frameId: stack.body.stackFrames[0].id });
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  const variables = await session.requestOk("variables", {
    variablesReference: locals.variablesReference,
  });
  assert.equal(variables.body.variables.find((variable) => variable.name === "b").value, "0");
});
