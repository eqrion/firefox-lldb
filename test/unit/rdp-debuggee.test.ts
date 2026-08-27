/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.js";
import type { RdpWasmSession } from "../../src/rdp/session.js";

test("RdpDebuggee.dispose removes its process-exit cleanup listener", () => {
  const before = process.listenerCount("exit");
  const session = new EventEmitter() as RdpWasmSession;
  const debuggee = new RdpDebuggee(session);
  assert.equal(process.listenerCount("exit"), before + 1);

  debuggee.dispose();
  debuggee.dispose();
  assert.equal(process.listenerCount("exit"), before);
});

/** Minimal RdpWasmSession stand-in for primeStop: one thread, and a paused
 * state the caller decides how to expose. */
function primeStopSession(opts: { unwitnessed: boolean; adoptEmitsStop: boolean }) {
  const session = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const calls: string[] = [];
  Object.assign(session, {
    listTids: () => [7],
    hasUnwitnessedPause: () => opts.unwitnessed,
    armAllStop: () => void calls.push("armAllStop"),
    // Firefox answers an interrupt aimed at an already-paused thread with an
    // error reply, so no "stopped" event ever follows: model that as silence.
    interrupt: () => void calls.push("interrupt"),
    adoptPausedState: async () => {
      calls.push("adoptPausedState");
      if (opts.adoptEmitsStop) session.emit("stopped", { tid: 7, pausePacket: {} });
      return true;
    },
    frames: async () => [],
    wasmSources: async () => [],
    jsSources: async () => [],
    selectStoppedTid: () => {},
    stoppedTid: 7,
  });
  return { session: session as unknown as RdpWasmSession, calls };
}

test("primeStop adopts an already-paused thread instead of interrupting it", async () => {
  const { session, calls } = primeStopSession({ unwitnessed: true, adoptEmitsStop: true });
  const debuggee = new RdpDebuggee(session);
  try {
    await debuggee.primeStop();
    assert.deepEqual(calls, ["adoptPausedState"]);
  } finally {
    debuggee.dispose();
  }
});

test("primeStop interrupts a running thread", async () => {
  const { session, calls } = primeStopSession({ unwitnessed: false, adoptEmitsStop: false });
  const debuggee = new RdpDebuggee(session);
  try {
    const primed = debuggee.primeStop();
    session.emit("stopped", { tid: 7, pausePacket: {} });
    await primed;
    assert.deepEqual(calls, ["armAllStop", "interrupt"]);
  } finally {
    debuggee.dispose();
  }
});

test("primeStop gives up rather than hanging when no stop ever arrives", async () => {
  // The pre-fix hang: interrupt draws an error reply, not a paused event, and
  // the wait had no bound. Attach must survive that.
  const { session, calls } = primeStopSession({ unwitnessed: true, adoptEmitsStop: false });
  const debuggee = new RdpDebuggee(session);
  try {
    await debuggee.primeStop(50);
    assert.deepEqual(calls, ["adoptPausedState"]);
  } finally {
    debuggee.dispose();
  }
});
