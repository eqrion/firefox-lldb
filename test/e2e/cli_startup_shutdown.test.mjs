/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { findFirefoxBinary } from "../../src/core/firefox.ts";

for (const entry of ["firefox-lldb-server", "firefox-lldb", "firefox-lldb-dap"]) {
  test(
    `${entry}: SIGTERM during browser startup joins rollback`,
    { timeout: 30_000 },
    async (t) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          `src/cli/${entry}.ts`,
          "--launch",
          "--headless",
          "--verbose",
          "--log",
          "--port",
          "0",
          "--rdp-port",
          String(await freePort()),
          ...(process.env.FIREFOX_BINARY ? ["--firefox", process.env.FIREFOX_BINARY] : []),
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const exited = once(child, "exit");
      let output = "";
      let spawned;
      const receive = (chunk) => {
        output += chunk;
        if (spawned) return;
        const match = output.match(/\[firefox\] launch\.spawned (\{[^\n]+\})/);
        if (!match) return;
        spawned = JSON.parse(match[1]);
        child.kill("SIGTERM");
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
      t.after(async () => {
        clearTimeout(guard);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        // Emergency ownership fallback if the entry point regresses. Never touch
        // unrelated browsers: only the group created by this child's launch.
        if (spawned?.pid) {
          try {
            process.kill(-spawned.pid, "SIGKILL");
          } catch {}
        }
      });
      const [code, signal] = await exited;
      clearTimeout(guard);
      assert.ok(spawned?.pid, output);
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
      assert.equal(existsSync(spawned.profileDir), false, output);
      assert.throws(() => process.kill(spawned.pid, 0), { code: "ESRCH" });
      assert.match(
        output,
        /cleanup\.verified/,
        "process cleanup should be confirmed in diagnostics"
      );
    }
  );
}

test(
  "REPL survives a real Firefox launcher handoff and drains inherited output",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "firefox-lldb-real-handoff-"));
    const report = join(directory, "browser.json");
    const helper = fileURLToPath(new URL("../helpers/firefox-handoff.mjs", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/firefox-lldb.ts",
        "--launch",
        "--headless",
        "--verbose",
        "--port",
        "0",
        "--rdp-port",
        String(await freePort()),
        "--firefox",
        helper,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FIREFOX_LLDB_HANDOFF_BINARY: process.env.FIREFOX_BINARY ?? findFirefoxBinary(),
          FIREFOX_LLDB_HANDOFF_REPORT: report,
          FIREFOX_LLDB_LOG_DIR: directory,
        },
      }
    );
    const exited = once(child, "exit");
    const guard = setTimeout(() => child.kill("SIGTERM"), 20_000);
    let output = "";
    let commanded = false;
    let version = false;
    let spawned;
    const receive = (chunk) => {
      output += chunk;
      const match = output.match(/\[firefox\] launch\.spawned (\{[^\n]+\})/);
      if (match) spawned = JSON.parse(match[1]);
      if (!commanded && output.includes("(lldb)")) {
        commanded = true;
        child.stdin.write("version\n");
      }
      if (commanded && /lldb version/.test(output)) {
        version = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    t.after(async () => {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      if (existsSync(report)) {
        const owned = JSON.parse(readFileSync(report, "utf8"));
        try {
          process.kill(-owned.pid, "SIGKILL");
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const [code, signal] = await exited;
    assert.equal(code, 0, output);
    assert.equal(signal, null, output);
    assert.equal(version, true, output);
    assert.match(output, /launcher\.exited/);
    assert.ok(spawned);
    assert.equal(existsSync(spawned.profileDir), false);
    assert.match(
      readFileSync(join(directory, `firefox-${spawned.launchToken}.log`), "utf8"),
      /handoff pipe drained/
    );
  }
);
