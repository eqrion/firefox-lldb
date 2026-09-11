/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchFirefox } from "../../src/core/firefox.ts";
import { parseCliArgs } from "../../src/cli/options.ts";
import { startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { tracingLogger, sleep } from "./harness.mjs";

const binary = fileURLToPath(new URL("../helpers/firefox-handoff.mjs", import.meta.url));
const options = { skip: process.platform === "win32", timeout: 35_000 };

test("failed process discovery cannot claim successful Firefox cleanup", options, () => {
  const helper = fileURLToPath(new URL("../helpers/firefox-cleanup-failure.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", helper], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.match(output, /cleanup rejected and retained its profile/);
});

function alive(pid) {
  try {
    const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

async function setup(t, keepLauncher = false) {
  const root = await mkdtemp(join(tmpdir(), "firefox-lldb-handoff-"));
  const report = join(root, "replacement.json");
  const previous = process.env.FIREFOX_LLDB_HANDOFF_REPORT;
  const previousKeep = process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER;
  process.env.FIREFOX_LLDB_HANDOFF_REPORT = report;
  if (keepLauncher) process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER = "1";
  else delete process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER;
  const trace = tracingLogger(60);
  t.after(async () => {
    // Independent cleanup for an assertion failure in the production path.
    const data = await readFile(report, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (data) {
      for (const pid of [data.pid, data.descendant]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    if (previous === undefined) delete process.env.FIREFOX_LLDB_HANDOFF_REPORT;
    else process.env.FIREFOX_LLDB_HANDOFF_REPORT = previous;
    if (previousKeep === undefined) delete process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER;
    else process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER = previousKeep;
    trace.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    trace,
    async replacement() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const data = await readFile(report, "utf8")
          .then(JSON.parse)
          .catch(() => undefined);
        if (data) return data;
        await sleep(20);
      }
      throw new Error(`handoff fixture did not start; transcript: ${trace.logPath}`);
    },
  };
}

for (const keepLauncher of [false, true]) {
  test(
    `cleanup owns a detached replacement with launcher ${keepLauncher ? "alive" : "exited"}`,
    options,
    async (t) => {
      const fixture = await setup(t, keepLauncher);
      const rdpPort = await freePort();
      const firefox = await launchFirefox({
        binary,
        headless: true,
        rdpPort,
        logger: fixture.trace,
      });
      t.after(() => firefox.close());
      const replacement = await fixture.replacement();
      assert.notEqual(replacement.pid, firefox.pid);
      assert.ok(alive(replacement.pid));
      if (!keepLauncher) {
        await firefox.exited;
        // Reproduce the old cleanup assumption: neither launcher exit nor a
        // signal to its original group stops the detached replacement.
        try {
          process.kill(-firefox.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        assert.ok(alive(replacement.pid));
      }
      const bystanders = [
        [firefox.profileDir + "-unrelated", rdpPort],
        [firefox.profileDir, String(rdpPort) + "0"],
      ].map(([profile, port]) =>
        spawn(
          process.execPath,
          [binary, "--bystander", "--profile", profile, "--start-debugger-server", String(port)],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] }
        )
      );
      t.after(async () => {
        await Promise.all(
          bystanders.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          })
        );
      });
      await Promise.all(bystanders.map((child) => once(child, "message")));
      const closed = firefox.close();
      assert.equal(firefox.close(), closed);
      await closed;
      assert.equal(alive(replacement.pid), false);
      assert.equal(alive(replacement.descendant), false);
      assert.ok(
        bystanders.every((child) => alive(child.pid)),
        "unrelated processes must survive"
      );
      await assert.rejects(access(firefox.profileDir), /ENOENT/);
      assert.match(fixture.trace.tail().join("\n"), /cleanup\.replacement/);
      assert.match(fixture.trace.tail().join("\n"), /cleanup\.verified/);
    }
  );
}

test("RDP startup failure rolls back a detached replacement", options, async (t) => {
  const fixture = await setup(t);
  const args = parseCliArgs([
    "--launch",
    "--headless",
    "--port",
    "0",
    "--rdp-port",
    String(await freePort()),
    "--firefox",
    binary,
  ]);
  await assert.rejects(
    startPlatformServer(args, { logger: fixture.trace }),
    /Firefox RDP startup (exhausted|timed out)/
  );
  const replacement = await fixture.replacement();
  assert.equal(alive(replacement.pid), false);
  assert.equal(alive(replacement.descendant), false);
  await assert.rejects(access(replacement.profileDir), /ENOENT/);
});
