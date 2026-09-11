/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DAPClient } from "./dap-harness.mjs";

test(
  "DAP harness rejects requests after the real adapter exits without a response timer",
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli/firefox-lldb-dap.ts", "--help"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const client = new DAPClient(child);
    t.after(() => child.kill("SIGTERM"));
    await client.exit();
    await assert.rejects(client.request("disconnect", {}, 10), /exited/);
    await assert.rejects(client.waitForEvent("stopped", undefined, 10), /exited/);
    // An orphan response timeout would fail node:test as an unhandled rejection.
    await delay(30);
  }
);

test(
  "DAP harness write failure settles pending replies and event waits exactly once",
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume(); setTimeout(() => process.exit(), 5000)"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const client = new DAPClient(child);
    t.after(async () => {
      child.kill("SIGTERM");
      await client.exit();
    });
    // Isolate the failed-write ordering while the child remains alive, so an exit
    // notification cannot accidentally clean up the orphan response promise.
    child.stdin.write = (_frame, callback) => {
      queueMicrotask(() => callback(new Error("injected DAP write failure")));
      return false;
    };
    const event = assert.rejects(
      client.waitForEvent("initialized", undefined, 10),
      /injected DAP write failure/
    );
    await assert.rejects(client.request("initialize", {}, 10), /injected DAP write failure/);
    await event;
    await assert.rejects(client.request("disconnect", {}, 10), /injected DAP write failure/);
    await delay(30);
  }
);
