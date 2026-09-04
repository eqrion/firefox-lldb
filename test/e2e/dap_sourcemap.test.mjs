/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP resolves source from a source map without inventing variable names", async () => {
  session = await DAPFixtureSession.attach("sourcemap_factorial", {
    configure: async (dap, fixture) => {
      const response = await dap.setSourceBreakpoints(fixture.file, [24]);
      assert.equal(response.body.breakpoints[0].verified, true, JSON.stringify(response));
    },
  });

  const threadId = session.stoppedEvent.body.threadId;
  const stack = await session.requestOk("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 20,
  });
  const frame = stack.body.stackFrames[0];
  assert.match(frame.name, /compute_factorial/);
  assert.equal(frame.source.path.endsWith("math.cpp"), true);
  assert.equal(frame.line, 24);

  const scopes = await session.requestOk("scopes", { frameId: frame.id });
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  const variables = await session.requestOk("variables", {
    variablesReference: locals.variablesReference,
  });
  assert.equal(
    variables.body.variables.some((variable) => variable.name === "n"),
    false
  );
});
