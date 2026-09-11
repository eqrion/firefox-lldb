/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.ts";
import { DebugFileRegistry } from "../../src/symbols/debug-files.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { startStaticServer, tracingLogger } from "./harness.mjs";

for (const retirement of [
  "navigation",
  "dispose",
  "source-dispose",
  "source-navigation",
  "frames-resume",
  "dwarf-navigation",
]) {
  test(`late symbol data cannot commit after ${retirement}`, { timeout: 25_000 }, async (t) => {
    const trace = tracingLogger();
    let tempDir;
    const logger = {
      ...trace,
      debug(message) {
        trace.debug(message);
        if (message.startsWith("[debuggee] created "))
          tempDir = JSON.parse(message.slice(message.indexOf("{"))).tempDir;
      },
    };
    const fixture = await startStaticServer(
      retirement === "dwarf-navigation" ? "test/fixtures/separate_dwarf" : "test/fixtures/simple"
    );
    const debugFiles = new DebugFileRegistry(logger);
    const url = `http://127.0.0.1:${fixture.port}/index.html`;
    let session, platform, debuggee, release;
    t.after(async () => {
      release?.();
      debuggee?.dispose();
      debugFiles.close();
      await platform?.shutdown();
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
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
        "--url",
        url,
        ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
      ]),
      {
        logger: trace,
        onTab() {},
        onSession(value) {
          session = value;
        },
      }
    );
    await platform.spawner.launch();
    const beforeListeners = session
      .eventNames()
      .reduce((sum, event) => sum + session.listenerCount(event), 0);
    debuggee = new RdpDebuggee(session, { logger, debugFiles });
    const call = (type, id, method, args = []) => debuggee.dispatch({ type, id, method, args });
    const [oldModule] = await call("Debuggee", 0, "allModules");
    assert.ok(oldModule);
    const originalFetch = session.fetchModuleBytes.bind(session);
    let fetched;
    const entered = new Promise((resolve) => {
      fetched = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    if (retirement === "source-navigation") {
      await debuggee.primeStop();
      assert.ok(readdirSync(tempDir).length > 0, "the stopped JS stack materializes source files");
      await session.navigate(url);
      assert.deepEqual(readdirSync(tempDir), [], "navigation retires its source directories");
      return;
    }
    if (retirement === "dwarf-navigation") {
      await call("Module", oldModule.id, "bytecode");
      const [serve] = fixture.server.listeners("request");
      let closed;
      const disconnected = new Promise((resolve) => {
        closed = resolve;
      });
      fixture.server.removeListener("request", serve);
      fixture.server.on("request", (request, response) => {
        if (request.url.endsWith("math.debug.wasm")) {
          response.once("close", closed);
          fetched();
        } else serve(request, response);
      });
      const pending = debugFiles.read("/math.debug.wasm");
      await entered;
      await session.navigate(url);
      assert.equal(await pending, null);
      await disconnected;
      assert.equal(
        await debugFiles.read("/math.debug.wasm"),
        null,
        "retired registrations must not intercept later file reads"
      );
      return;
    }
    if (retirement === "frames-resume") {
      const originalFrames = session.frames.bind(session);
      session.frames = async (tid) => {
        const frames = await originalFrames(tid);
        fetched();
        await gate;
        return frames;
      };
      const rejected = assert.rejects(debuggee.primeStop(), /snapshot retired/);
      await entered;
      await session.resumeAll();
      release();
      await rejected;
      return;
    }
    if (retirement === "source-dispose") {
      const originalSource = session.fetchSourceText.bind(session);
      session.fetchSourceText = async (actor) => {
        const text = await originalSource(actor);
        fetched();
        await gate;
        return text;
      };
      const rejected = assert.rejects(debuggee.primeStop(), /disposed/);
      await entered;
      assert.equal(existsSync(tempDir), true);
      debuggee.dispose();
      assert.equal(existsSync(tempDir), false);
      release();
      await rejected;
      assert.equal(
        existsSync(tempDir),
        false,
        "late source completion must not recreate its disposed directory"
      );
      return;
    }
    let fetches = 0;
    session.fetchModuleBytes = async (moduleUrl) => {
      fetches++;
      const bytes = await originalFetch(moduleUrl);
      if (fetches === 1) {
        fetched();
        await gate;
      }
      return bytes;
    };
    const pending = call("Module", oldModule.id, "bytecode");
    const rejected = assert.rejects(pending, /generation retired|disposed/);
    await entered;
    if (retirement === "navigation") {
      const generation = session.topLevelGeneration();
      await session.navigate(url);
      assert.ok(session.topLevelGeneration() > generation);
    } else {
      debuggee.dispose();
      assert.equal(
        session.eventNames().reduce((sum, event) => sum + session.listenerCount(event), 0),
        beforeListeners
      );
      assert.throws(() => call("Debuggee", 0, "allModules"), /disposed/);
    }
    release();
    await rejected;
    if (retirement === "navigation") {
      // The page may still be compiling its async module after DOM interactive.
      let current;
      for (let attempt = 0; attempt < 50 && !current; attempt++) {
        [current] = await call("Debuggee", 0, "allModules");
        if (!current) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(current);
      assert.notEqual(current.id, oldModule.id);
      await call("Module", current.id, "bytecode");
      assert.equal(fetches, 2, "retired completion must not populate the new generation's cache");
    }
  });
}
