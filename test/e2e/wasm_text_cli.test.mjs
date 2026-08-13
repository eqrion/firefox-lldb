/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Production CLI proof for automatic ecosystem discovery and virtual WAT
// source presentation. No --component URL routes are supplied.

import assert from "node:assert/strict";
import test from "node:test";
import { PtyRepl } from "../../src/mcp/pty-repl.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { startStaticServer } from "./harness.mjs";

test("the generic CLI discovers and presents the Wasm text fallback", async () => {
  const staticServer = await startStaticServer("test/fixtures/two-components");
  let repl;
  try {
    const rdpPort = await freePort();
    let marionettePort = await freePort();
    while (marionettePort === rdpPort) marionettePort = await freePort();
    let platformPort = await freePort();
    while (platformPort === rdpPort || platformPort === marionettePort) {
      platformPort = await freePort();
    }
    repl = await PtyRepl.launch({
      url: `http://127.0.0.1:${staticServer.port}/mixed-wat.html`,
      headless: true,
      platformPort,
      rdpPort,
      marionettePort,
      startupTimeoutMs: 120_000,
    });

    // modules also catches a second module which raced initial discovery and
    // performs its stopped late-component activation before returning.
    const modules = await repl.send("modules", 120_000);
    assert.equal(modules.prompt, true, modules.output.slice(-4000));
    assert.match(modules.output, /math\.wasm.*\[lldb\]|\[lldb\].*math\.wasm/);
    assert.match(modules.output, /plain\.wasm.*\[wasm-text\]|\[wasm-text\].*plain\.wasm/);

    const components = await repl.send("components");
    assert.match(components.output, /lldb\s+LLDB/);
    assert.match(components.output, /wasm-text\s+WebAssembly Text/);
    const sources = await repl.send("sources");
    assert.match(sources.output, /wasm-text:\/\/.+\/module\.wat/);

    const breakpoint = await repl.send("break wasm-text::wat_factorial");
    assert.match(breakpoint.output, /Breakpoint wasm-text:\d+: verified/);
    await repl.send("js p debuggersReady.then(() => setTimeout(() => runMixed(), 100))");
    const stopped = await repl.send("continue lldb", 60_000);
    assert.equal(stopped.prompt, true, stopped.output.slice(-4000));

    const backtrace = await repl.send("bt");
    assert.match(backtrace.output, /#0 wat_factorial.*\[wasm-text\]/);
    assert.match(backtrace.output, /call_other_factorial.*\[lldb\]/);
    const source = await repl.send("list");
    assert.match(source.output, /=>\s+\d+\s+.*;; @0x[0-9a-f]+/);
    const locals = await repl.send("locals");
    assert.match(locals.output, /\$local0\s*=/);
  } finally {
    await repl?.shutdown().catch(() => {});
    staticServer.server.closeAllConnections();
    await new Promise((resolve) => staticServer.server.close(resolve));
  }
});
