/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { parseCliArgs } from "../../src/cli/options.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { RspClient } from "../unit/rsp-client.ts";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.ts";
import { tracingLogger } from "./harness.mjs";

test(
  "a real component crash after readiness terminates its runtime owner",
  { timeout: 20_000 },
  async (t) => {
    const trace = tracingLogger();
    const dispatch = RdpDebuggee.prototype.dispatch;
    let crash = false;
    RdpDebuggee.prototype.dispatch = function (request) {
      if (crash) throw new Error("deliberate published component host failure");
      return dispatch.call(this, request);
    };
    t.after(() => {
      RdpDebuggee.prototype.dispatch = dispatch;
    });
    let platform, rsp;
    t.after(async () => {
      rsp?.close();
      await platform?.shutdown();
      trace.close();
    });
    platform = await startPlatformServer(
      parseCliArgs([
        "--launch",
        "--headless",
        "--port",
        "0",
        "--rdp-port",
        String(await freePort()),
        ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
      ]),
      { logger: trace, onTab() {} }
    );
    const server = await platform.spawner.launch();
    rsp = await RspClient.connect(server.port);
    assert.match(await rsp.requestText("vAttach;1"), /^[TS]/);
    // The attached byte pipe must preserve the real component's terminal error,
    // even with no LLDB command promise waiting for a reply.
    crash = true;
    void rsp.requestText("c");
    const error = await platform.failed;
    assert.match(error.message, /deliberate published component host failure/);
    await platform.shutdown();
    assert.deepEqual(platform.spawner.list(), []);
  }
);

test(
  "an idle per-tab RDP disconnect terminates its runtime owner",
  { timeout: 20_000 },
  async (t) => {
    const trace = tracingLogger();
    let platform, session;
    t.after(async () => {
      await platform?.shutdown();
      trace.close();
    });
    platform = await startPlatformServer(
      parseCliArgs([
        "--launch",
        "--headless",
        "--port",
        "0",
        "--rdp-port",
        String(await freePort()),
        ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
      ]),
      {
        logger: trace,
        onTab() {},
        onRdpSession(value) {
          session = value;
        },
      }
    );
    await platform.spawner.launch();
    // No LLDB connection or command is needed to notice the lost RDP lifetime.
    session.close();
    assert.match((await platform.failed).message, /per-tab Firefox RDP connection closed/);
    await platform.shutdown();
    assert.deepEqual(platform.spawner.list(), []);
  }
);

test(
  "fatal exception cleanup retains diagnostics and terminates a real Firefox",
  { timeout: 20_000 },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "firefox-lldb-fatal-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const logPath = join(directory, "fatal.log");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/helpers/session-log-browser-fatal.ts", logPath],
      { encoding: "utf8", timeout: 18_000 }
    );
    assert.equal(result.status, 1, result.stderr);
    const owned = JSON.parse(result.stdout);
    assert.equal(existsSync(owned.profileDir), false);
    assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /deliberate fatal failure with an owned Firefox/);
    assert.match(log, /fatal browser cleanup completed/);
    assert.match(result.stderr, /Full session log retained/);
  }
);
