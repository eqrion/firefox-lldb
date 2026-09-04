/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP exposes nested variables, evaluate, memory, and mutation errors", async () => {
  session = await DAPFixtureSession.attach("types");
  const threads = await session.requestOk("threads");
  const stack = await session.requestOk("stackTrace", {
    threadId: threads.body.threads[0].id,
    startFrame: 0,
    levels: 20,
  });
  const frame = stack.body.stackFrames.find((candidate) => /check_types/.test(candidate.name));
  assert.ok(frame, JSON.stringify(stack));

  const scopes = await session.requestOk("scopes", { frameId: frame.id });
  const locals = scopes.body.scopes.find((scope) => /local/i.test(scope.name));
  assert.ok(locals, JSON.stringify(scopes));
  const variables = await session.requestOk("variables", {
    variablesReference: locals.variablesReference,
  });
  const byName = new Map(variables.body.variables.map((variable) => [variable.name, variable]));
  assert.equal(byName.get("i")?.value, "-42");
  assert.ok(byName.get("pt")?.variablesReference > 0);

  const point = await session.requestOk("variables", {
    variablesReference: byName.get("pt").variablesReference,
  });
  assert.match(point.body.variables.find((variable) => variable.name === "x").value, /1\.5/);
  assert.match(point.body.variables.find((variable) => variable.name === "y").value, /2\.5/);

  const evaluated = await session.requestOk("evaluate", {
    expression: "i + 1",
    frameId: frame.id,
    context: "watch",
  });
  assert.match(evaluated.body.result, /-41/);

  const invalid = await session.request("evaluate", {
    expression: "does_not_exist",
    frameId: frame.id,
    context: "watch",
  });
  assert.equal(invalid.success, false);

  const changed = await session.request("setVariable", {
    variablesReference: locals.variablesReference,
    name: "i",
    value: "-41",
  });
  assert.equal(changed.success, false);
  assert.match(changed.body.error.format, /memory write failed/);

  const pointer = byName.get("p");
  assert.ok(pointer.memoryReference, JSON.stringify(pointer));
  const memory = await session.requestOk("readMemory", {
    memoryReference: pointer.memoryReference,
    count: 4,
  });
  const pointerValue = Buffer.from(memory.body.data, "base64").readUInt32LE(0);
  assert.equal(pointerValue, Number.parseInt(pointer.value, 16));

  const pointee = await session.requestOk("readMemory", {
    memoryReference: `0x${pointerValue.toString(16)}`,
    count: 4,
  });
  assert.equal(Buffer.from(pointee.body.data, "base64").readInt32LE(0), -42);
});
