/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP accepts conditional, hit-count, and log breakpoints", async () => {
  session = await DAPFixtureSession.attach("factorial", {
    configure: async (dap) => {
      const functions = await dap.requestOk("setFunctionBreakpoints", {
        breakpoints: [{ name: "factorial", hitCondition: "3" }],
      });
      assert.equal(functions.body.breakpoints[0].verified, true, JSON.stringify(functions));

      const logpoints = await dap.requestOk("setBreakpoints", {
        source: { name: "math.cpp", path: "math.cpp" },
        breakpoints: [{ line: 5, condition: "n >= 9", logMessage: "factorial n={n}" }],
      });
      assert.equal(logpoints.body.breakpoints[0].verified, true, JSON.stringify(logpoints));
    },
  });

  const output = await session.waitForEvent("output", (event) =>
    /factorial n=/.test(event.body?.output ?? "")
  );
  assert.match(output.body.output, /factorial n=/);

  const stack = await session.requestOk("stackTrace", {
    threadId: session.stoppedEvent.body.threadId,
    startFrame: 0,
    levels: 1,
  });
  const scopes = await session.requestOk("scopes", { frameId: stack.body.stackFrames[0].id });
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  const variables = await session.requestOk("variables", {
    variablesReference: locals.variablesReference,
  });
  assert.equal(variables.body.variables.find((variable) => variable.name === "n").value, "8");
});
