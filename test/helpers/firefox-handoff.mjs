#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A bounded stand-in for a launcher handing off to a new process group.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
// Independent safety net: a failed test must not leave this fixture running.
setTimeout(() => process.exit(0), 45_000);
if (process.env.FIREFOX_LLDB_HANDOFF_BINARY) {
  const browser = spawn(process.env.FIREFOX_LLDB_HANDOFF_BINARY, args, {
    detached: true,
    stdio: "inherit",
  });
  browser.once("spawn", () => {
    writeFileSync(
      process.env.FIREFOX_LLDB_HANDOFF_REPORT,
      JSON.stringify({ pid: browser.pid, profileDir: args[args.indexOf("--profile") + 1] })
    );
    const writer = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('handoff pipe drained\\n'), 100)"],
      { stdio: "inherit" }
    );
    writer.unref();
    browser.unref();
    process.exit(0);
  });
} else if (args.includes("--bystander") || args.includes("--descendant")) {
  process.send?.("ready");
} else if (args.includes("--replacement")) {
  const descendant = spawn(process.execPath, [self, "--descendant"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", () => {
    descendant.disconnect();
    descendant.unref();
    writeFileSync(
      process.env.FIREFOX_LLDB_HANDOFF_REPORT,
      JSON.stringify({
        pid: process.pid,
        descendant: descendant.pid,
        profileDir: args[args.indexOf("--profile") + 1],
      })
    );
    process.send?.("ready");
  });
} else {
  const replacement = spawn(process.execPath, [self, "--replacement", ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  replacement.once("message", () => {
    replacement.disconnect();
    replacement.unref();
    if (!process.env.FIREFOX_LLDB_HANDOFF_KEEP_LAUNCHER) process.exit(0);
  });
}
