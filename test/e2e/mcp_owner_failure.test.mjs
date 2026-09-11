/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplOwner } from "../../src/mcp/repl-owner.ts";
import { PtyRepl } from "../../src/mcp/pty-repl.ts";
import { startStaticServer } from "./harness.mjs";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";

test(
  "MCP refuses replacement after an owned CLI cleanup failure",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await startStaticServer("test/fixtures/simple");
    const owner = new ReplOwner();
    const shutdown = PtyRepl.prototype.shutdown;
    t.after(async () => {
      PtyRepl.prototype.shutdown = shutdown;
      await owner.close().catch(() => {});
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
    });
    const options = {
      url: `http://127.0.0.1:${fixture.port}/index.html`,
      headless: true,
      marionettePort: await freePort(),
    };
    const repl = await owner.replace(options);
    assert.match((await repl.send("version")).output, /lldb version/i);
    await assert.rejects(repl.send("x".repeat(65537)), /command exceeds/);
    PtyRepl.prototype.shutdown = async function () {
      // Release the real CLI first so the deliberately failed acknowledgement cannot leak it.
      await shutdown.call(this);
      throw new Error("deliberate cleanup acknowledgement failure");
    };
    await assert.rejects(owner.replace(options), /REPL cleanup failed/);
    assert.equal(owner.active, undefined);
    await assert.rejects(owner.replace(options), /REPL cleanup failed/);
    await assert.rejects(owner.shutdown(), /REPL cleanup failed/);
  }
);
