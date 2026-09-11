/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { launchFirefox } from "../../src/core/firefox.ts";
import { RdpWasmSession } from "../../src/rdp/session.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { RdpDebuggee } from "../../src/gdb/rdp-debuggee.ts";
import { startGdbServer } from "../../src/gdb/worker/host.mjs";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { tracingLogger } from "./harness.mjs";

for (const mode of [
  "ready",
  "blocked",
  "failure",
  "modeled-error",
  "fatal-modeled-word",
  "response-bound",
]) {
  test(
    `real component worker ${mode} startup has one terminal owner`,
    { timeout: 20_000 },
    async (t) => {
      const trace = tracingLogger();
      const rdpPort = await freePort();
      const firefox = await launchFirefox({
        rdpPort,
        headless: true,
        logger: trace,
        binary: process.env.FIREFOX_BINARY,
      });
      let session, debuggee, worker, release;
      t.after(async () => {
        release?.();
        await worker?.stop();
        debuggee?.dispose();
        session?.close();
        await firefox.close();
        trace.close();
      });
      await verifyFirefoxLaunchToken(rdpPort, "127.0.0.1", firefox.launchToken);
      session = await RdpWasmSession.start(rdpPort, "127.0.0.1", undefined, trace);
      await session.waitForTopLevelTarget();
      debuggee = new RdpDebuggee(session, { logger: trace });
      await debuggee.primeStop();
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const failures = [];
      const records = [];
      worker = startGdbServer({
        port: 0,
        startupTimeoutMs: mode === "blocked" ? 1000 : 10_000,
        async dispatch(request) {
          if (mode === "blocked") await blocked;
          if (mode === "failure") throw new Error("deliberate initial snapshot failure");
          if (mode === "response-bound") return new Uint8Array(32 * 1024 * 1024);
          if (request.type === "Debuggee" && request.method === "exitFrames") {
            if (mode === "modeled-error")
              throw Object.assign(new Error("diagnostic text differs from the WIT tag"), {
                payload: "invalid-frame",
              });
            if (mode === "fatal-modeled-word") throw new Error("invalid-frame");
          }
          return debuggee.dispatch(request);
        },
        onTrace(message) {
          records.push(message);
          trace.debug(message);
        },
        onError: (message) => trace.error(message),
        onFailure: (error) => failures.push(error),
      });
      const shouldStart = mode === "ready" || mode === "modeled-error";
      if (shouldStart) {
        await worker.ready;
        assert.ok(worker.port > 0);
        assert.match(records.join("\n"), /\[worker\] listening port=/);
        const client = net.connect(worker.port, "127.0.0.1");
        t.after(() => client.destroy());
        await once(client, "connect");
        client.destroy();
      } else {
        await assert.rejects(
          worker.ready,
          mode === "blocked"
            ? /startup timed out/
            : mode === "response-bound"
              ? /RPC message exceeds 32 MiB/
              : mode === "fatal-modeled-word"
                ? /invalid-frame/
                : /deliberate initial snapshot failure/
        );
        assert.equal(failures.length, 1);
        assert.doesNotMatch(records.join("\n"), /\[worker\] listening/);
      }
      const closing = worker.stop();
      assert.equal(worker.stop(), closing);
      await closing;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(failures.length, shouldStart ? 0 : 1);
    }
  );
}
