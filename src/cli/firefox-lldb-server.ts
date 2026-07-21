#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Standalone platform server CLI: same bring-up as the embedded firefox-lldb
// wrapper, but LLDB reaches it over a real TCP port instead of an in-process
// bridge, for use with an external native lldb.

import { pathToFileURL } from "node:url";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { exitWhenOrphaned } from "../config.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const handle = await startPlatformServer(args);
  // Stdout is the control channel for the firefox-lldb wrapper; stderr carries logs.
  process.stdout.write(`platform server ready on connect://localhost:${handle.port}\n`);

  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle.shutdown().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      }
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  // When launched session-detached (e.g. the e2e harness uses setsid), a killed
  // parent does not signal us, so we would orphan the launched Firefox. Poll for
  // reparenting to init/launchd (ppid 1) and shut down cleanly when it happens.
  if (exitWhenOrphaned()) {
    const timer = setInterval(() => {
      if (process.ppid === 1) {
        onSignal();
      }
    }, 1000);
    timer.unref();
  }
}

// Only run as a CLI when invoked directly, not when imported for in-process use.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
