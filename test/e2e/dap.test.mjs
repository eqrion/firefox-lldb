/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => {
  await session?.shutdown();
});

test("built-in LLDB DAP debugs WebAssembly in Firefox", async () => {
  session = await DAPFixtureSession.attach("factorial");

  const threads = await session.request("threads");
  assert.equal(threads.success, true, JSON.stringify(threads));
  assert.ok(threads.body.threads.length >= 1);

  const stack = await session.request("stackTrace", {
    threadId: threads.body.threads[0].id,
    startFrame: 0,
    levels: 20,
  });
  assert.equal(stack.success, true, JSON.stringify(stack));
  assert.match(stack.body.stackFrames[0].name, /compute_factorial/);
  assert.equal(stack.body.stackFrames[0].source.path.endsWith("math.cpp"), true);
  assert.equal(stack.body.stackFrames[0].line, 24);

  const scopes = await session.request("scopes", { frameId: stack.body.stackFrames[0].id });
  assert.equal(scopes.success, true, JSON.stringify(scopes));
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  assert.ok(locals, `expected a locals scope: ${JSON.stringify(scopes)}`);

  const variables = await session.request("variables", {
    variablesReference: locals.variablesReference,
  });
  assert.equal(variables.success, true, JSON.stringify(variables));
  const n = variables.body.variables.find((variable) => variable.name === "n");
  assert.ok(n, `expected local n: ${JSON.stringify(variables)}`);
  assert.equal(n.value, "10");

  const continuedEvent = session.waitForEvent("continued");
  const continued = await session.request("continue", { threadId: threads.body.threads[0].id });
  assert.equal(continued.success, true, JSON.stringify(continued));
  await continuedEvent;
});
