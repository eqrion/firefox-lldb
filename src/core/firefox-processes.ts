/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../diagnostics/logger.js";

const exec = promisify(execFile);
const SCAN_INTERVAL_MS = 100;
const QUIET_MS = 500;
const CLEANUP_MS = 4000;

interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
  command: string;
}

async function processes(): Promise<ProcessInfo[]> {
  // Wide output avoids truncating the profile/port identity. A timeout or
  // oversized process table is a cleanup failure, never evidence of absence.
  const { stdout } = await exec(
    "/bin/ps",
    ["-ax", "-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,args="],
    { timeout: 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }
  );
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/
    );
    if (!match) {
      if (line.trim()) throw new Error("could not parse Firefox cleanup process snapshot");
      return [];
    }
    return [
      {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        state: match[4]!,
        started: match[5]!,
        command: match[6]!,
      },
    ];
  });
}

/** Stop launch replacements that escaped the original POSIX process group. */
export async function stopFirefoxReplacements(
  profileDir: string,
  rdpPort: number,
  logger: Logger
): Promise<void> {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // These adjacent arguments are supplied by launchFirefox and survive macOS
  // relaunch. Neither an executable name nor a port alone establishes ownership.
  const identity = new RegExp(
    `(?:^| )--profile ${escape(profileDir)} --start-debugger-server ${rdpPort}(?: |$)`
  );
  const known = new Map<number, string>();
  const deadline = performance.now() + CLEANUP_MS;
  let quietSince: number | undefined;
  let remaining: number[] = [];
  while (performance.now() < deadline) {
    const snapshot = await processes();
    const owned = new Set<number>();
    for (const p of snapshot) {
      if (identity.test(p.command) || known.get(p.pid) === p.started) owned.add(p.pid);
    }
    // Capture descendants before signaling their parent, then retain their
    // start time across reparenting; discard a PID if that start time changed.
    let added: boolean;
    do {
      added = false;
      for (const p of snapshot) {
        if (owned.has(p.parent) && !owned.has(p.pid)) {
          owned.add(p.pid);
          added = true;
        }
      }
    } while (added);
    remaining = [];
    for (const p of snapshot) {
      if (!owned.has(p.pid)) continue;
      known.set(p.pid, p.started);
      if (p.state.startsWith("Z")) continue; // dead; its parent/OS must reap it
      remaining.push(p.pid);
      logger.debug(
        `[firefox] cleanup.replacement ${JSON.stringify({
          pid: p.pid,
          parent: p.parent,
          group: p.group,
          profileDir,
          rdpPort,
        })}`
      );
      try {
        // A verified group leader also owns children created since this
        // snapshot. Do not signal a group led by an unrelated process.
        if (p.group === p.pid) {
          try {
            process.kill(-p.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        process.kill(p.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (remaining.length) quietSince = undefined;
    else {
      quietSince ??= performance.now();
      if (performance.now() - quietSince >= QUIET_MS) {
        logger.debug(`[firefox] cleanup.verified ${JSON.stringify({ profileDir, rdpPort })}`);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
  }
  throw new Error(
    `Firefox replacement cleanup timed out: profile=${profileDir} port=${rdpPort} pids=${remaining.join(",")}`
  );
}
