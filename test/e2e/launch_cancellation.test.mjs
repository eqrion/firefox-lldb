/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { launchFirefox } from "../../src/core/firefox.ts";
import { verifyFirefoxLaunchToken } from "../../src/rdp/browser.ts";
import { packetGate } from "../helpers/rdp-gate.mjs";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { startStaticServer, tracingLogger } from "./harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("Firefox cancellation during profile setup removes the profile without spawning", async (t) => {
  const abort = new AbortController();
  const trace = tracingLogger();
  t.after(() => trace.close());
  let profileDir;
  let spawned = false;
  await assert.rejects(
    launchFirefox({
      rdpPort: await freePort(),
      headless: true,
      binary: process.env.FIREFOX_BINARY,
      signal: abort.signal,
      logger: {
        ...trace,
        debug(message) {
          trace.debug(message);
          if (message.startsWith("[firefox] launch.profile-acquired ")) {
            profileDir = JSON.parse(message.slice(message.indexOf("{"))).profileDir;
            abort.abort(new Error("cancel profile acquisition"));
          }
          if (message.startsWith("[firefox] launch.spawned ")) spawned = true;
        },
      },
    }),
    /cancel profile acquisition/
  );
  assert.ok(profileDir);
  assert.equal(existsSync(profileDir), false);
  assert.equal(spawned, false);
});

test("platform cancellation after Firefox spawn joins browser and listener rollback", async (t) => {
  const abort = new AbortController();
  const trace = tracingLogger();
  t.after(() => trace.close());
  let spawned;
  let platformPort;
  const logger = {
    ...trace,
    debug(message) {
      trace.debug(message);
      if (message.startsWith("[state] platform.listening "))
        platformPort = JSON.parse(message.slice(message.indexOf("{"))).port;
      if (message.startsWith("[firefox] launch.spawned ")) {
        spawned = JSON.parse(message.slice(message.indexOf("{")));
        abort.abort(new Error("cancel before platform handle publication"));
      }
    },
  };
  const args = parseCliArgs([
    "--launch",
    "--headless",
    "--port",
    "0",
    "--rdp-port",
    String(await freePort()),
    ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
  ]);
  await assert.rejects(
    within(
      startPlatformServer(args, { logger, signal: abort.signal }),
      15_000,
      "startup rollback hung"
    ),
    /cancel before platform handle publication/
  );
  assert.ok(spawned?.pid, "the real Firefox process was acquired before cancellation");
  assert.equal(existsSync(spawned.profileDir), false, "rollback removes the owned profile");
  assert.throws(() => process.kill(spawned.pid, 0), { code: "ESRCH" });
  const socket = net.connect(platformPort, "127.0.0.1");
  t.after(() => socket.destroy());
  const [error] = await once(socket, "error");
  assert.equal(error.code, "ECONNREFUSED", "rollback releases the platform listener");
});

test("Firefox readiness cancellation closes a withheld real root greeting", async (t) => {
  const trace = tracingLogger();
  t.after(() => trace.close());
  const port = await freePort();
  const firefox = await launchFirefox({
    rdpPort: port,
    headless: true,
    logger: trace,
    binary: process.env.FIREFOX_BINARY,
  });
  t.after(() => firefox.close());
  await verifyFirefoxLaunchToken(port, "127.0.0.1", firefox.launchToken);
  const gate = await packetGate(port, (packet) => packet.from === "root" && packet.applicationType);
  t.after(() => gate.close());
  const abort = new AbortController();
  const result = verifyFirefoxLaunchToken(
    gate.port,
    "127.0.0.1",
    firefox.launchToken,
    80,
    abort.signal,
    trace
  );
  const rejected = assert.rejects(result, /readiness cancelled/);
  await within(gate.held, 5000, "root greeting never arrived");
  abort.abort(new Error("readiness cancelled"));
  await within(rejected, 2000, "readiness ignored cancellation");
  await within(gate.peersClosed(), 2000, "readiness left an RDP socket open");
});

async function within(work, ms, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const boundary of [
  "greeting",
  "initialization",
  "initial-target",
  "sources",
  "navigation",
  "prime-stop",
  "worker-ready",
]) {
  test(
    `shutdown cancels withheld Firefox traffic at ${boundary}`,
    { timeout: 25_000 },
    async (t) => {
      const trace = tracingLogger(100);
      const records = [];
      const stageReached = deferred();
      let stage;
      const logger = {
        ...trace,
        debug(message) {
          records.push(message);
          trace.debug(message);
          const match = message.match(/\[launch\] stage=(\S+)/);
          if (match) {
            stage = match[1];
            if (stage === boundary) stageReached.resolve();
          }
        },
      };
      let firefox, proxy, handle, staticServer;
      t.after(async () => {
        // Opening the fault-injection boundary first also provides independent
        // cleanup if production cancellation regresses.
        await proxy?.close();
        try {
          await handle?.shutdown();
        } finally {
          try {
            await firefox?.close();
          } finally {
            if (staticServer) {
              staticServer.server.closeAllConnections();
              await new Promise((resolve) => staticServer.server.close(resolve));
            }
            trace.close();
          }
        }
      });
      const rdpPort = await freePort();
      firefox = await launchFirefox({
        rdpPort,
        binary: process.env.FIREFOX_BINARY,
        headless: true,
        logger,
      });
      await verifyFirefoxLaunchToken(rdpPort, "127.0.0.1", firefox.launchToken);
      proxy = await packetGate(rdpPort, (packet, request) => {
        switch (boundary) {
          case "greeting":
            return packet.from === "root" && packet.applicationType;
          case "initialization":
            return request === "getWatcher";
          case "initial-target":
            return packet.type === "target-available-form";
          case "navigation":
            return request === "navigateTo";
          case "prime-stop":
            return stage === boundary && packet.type === "paused";
          default:
            return stage === boundary && request === "sources";
        }
      });
      staticServer = await startStaticServer("test/fixtures/simple");
      const args = parseCliArgs([
        "--connect",
        "--port",
        "0",
        "--rdp-port",
        String(proxy.port),
        "--url",
        `http://127.0.0.1:${staticServer.port}/index.html`,
      ]);
      handle = await startPlatformServer(args, { logger, onTab() {} });
      // Enter through the production spawner/launcher; the embedded frontend's
      // command timeout is covered separately by launch_shutdown.test.mjs.
      const rejected = assert.rejects(handle.spawner.launch(), /aborted|cancelled|closed/);
      await proxy.held;
      if (!["greeting", "initialization"].includes(boundary)) {
        // Initial target events can precede the final initialization reply.
        await stageReached.promise;
        assert.equal(stage, boundary);
      }
      await within(
        Promise.all([handle.shutdown(), rejected, proxy.peersClosed()]),
        2000,
        `shutdown failed to cancel ${boundary}; transcript: ${trace.logPath}`
      );
      assert.deepEqual(handle.spawner.list(), []);
      const transcript = records.join("\n");
      assert.match(transcript, /\[spawner\] stop.completed/);
      assert.doesNotMatch(transcript, /\[spawner\] launch.ready|\[component\] Debugger listening/);
      if (boundary === "worker-ready")
        assert.match(transcript, /\[rpc\] request .*Debuggee.allModules/);
    }
  );
}
