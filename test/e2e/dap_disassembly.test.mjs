/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DAPFixtureSession } from "./dap-harness.mjs";

let session;
after(async () => session?.shutdown());

test("DAP disassembles wasm and stops on a live instruction breakpoint", async () => {
  session = await DAPFixtureSession.attach("factorial");
  assert.equal(session.initializeResponse.body.supportsDisassembleRequest, true);
  assert.equal(session.initializeResponse.body.supportsInstructionBreakpoints, true);

  const threadId = session.stoppedEvent.body.threadId;
  const stack = await session.requestOk("stackTrace", {
    threadId,
    startFrame: 0,
    levels: 1,
  });
  const frame = stack.body.stackFrames[0];
  assert.ok(frame.instructionPointerReference, JSON.stringify(frame));

  const disassembly = await session.requestOk("disassemble", {
    memoryReference: frame.instructionPointerReference,
    instructionOffset: 0,
    instructionCount: 12,
    resolveSymbols: true,
  });
  assert.ok(disassembly.body.instructions.length >= 4, JSON.stringify(disassembly));
  assert.ok(disassembly.body.instructions.every((instruction) => instruction.address));
  assert.ok(disassembly.body.instructions.some((instruction) => instruction.instruction));

  const target = disassembly.body.instructions[3].address;
  await session.setFunctionBreakpoints([]);
  const breakpoint = await session.requestOk("setInstructionBreakpoints", {
    breakpoints: [{ instructionReference: target }],
  });
  assert.equal(breakpoint.body.breakpoints[0].verified, true, JSON.stringify(breakpoint));

  const stopped = await session.continueAndWait(threadId);
  assert.equal(stopped.body.reason, "instruction breakpoint");
  const stoppedStack = await session.requestOk("stackTrace", {
    threadId: stopped.body.threadId,
    startFrame: 0,
    levels: 1,
  });
  assert.equal(stoppedStack.body.stackFrames[0].instructionPointerReference, target);
});
