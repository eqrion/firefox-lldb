/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplSession } from "./repl-harness.mjs";

test("real Firefox memory failures stay errors through the component and LLDB", async (t) => {
  const session = await ReplSession.attach("factorial");
  t.after(() => session.shutdown());
  await session.type("breakpoint set -n compute_factorial");
  assert.match(await session.type("continue"), /compute_factorial/);
  const read = (address) => session.type(`memory read --force --size 1 --count 16 ${address}`);
  assert.doesNotMatch(await read("0x1000"), /error:/);

  const evaluate = session.session.evaluateInFrame.bind(session.session);
  let injected = 0;
  session.session.evaluateInFrame = (expression, ...args) => {
    if (expression.includes("new Uint8Array")) {
      injected++;
      return evaluate("(()=>{throw new Error('deliberate memory evaluation failure')})()", ...args);
    }
    return evaluate(expression, ...args);
  };
  const failed = await read("0x2000");
  assert.ok(injected > 0, "failure must come from a real Firefox evaluation");
  assert.match(failed, /error:.*(?:memory|read)/i);
  session.session.evaluateInFrame = evaluate;

  assert.match(await read("0xfffffff0"), /error:.*(?:memory|read)/i);
  assert.doesNotMatch(await read("0x3000"), /error:/, "a failed read must not kill the worker");

  const packet = (value) => session.type(`process plugin packet send ${value}`);
  assert.match(await packet("qWasmGlobal:0;0"), /response: [0-9a-f]{8}/i);
  const environment = session.session.frameEnvironment.bind(session.session);
  session.session.frameEnvironment = async (...args) => {
    const env = await environment(...args);
    for (let scope = env; scope; scope = scope.parent) {
      if (scope.scopeKind === "wasm instance") delete scope.bindings.variables.global0;
    }
    return env;
  };
  assert.match(await packet("qWasmGlobal:0;0"), /response: \s*\n/);
  session.session.frameEnvironment = environment;
  assert.match(await packet("qWasmGlobal:0;0"), /response: [0-9a-f]{8}/i);

  session.session.evaluateInFrame = (expression, ...args) =>
    evaluate(
      expression === "memory0.buffer.byteLength"
        ? "(()=>{throw new Error('deliberate memory size failure')})()"
        : expression,
      ...args
    );
  assert.match(await packet("qXfer:memory-map:read::0,fff"), /response: E[0-9a-f]+/i);
  session.session.evaluateInFrame = evaluate;
  assert.match(await packet("qXfer:memory-map:read::0,fff"), /memory type="ram"/);
});
