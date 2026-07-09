/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Launch a headless Firefox with an isolated, throwaway profile and the RDP
// debugger server enabled. Used by the live test bridge so an lldb test can
// debug real wasm in a real browser without touching the user's Firefox.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { accessSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** True if something is already accepting connections on host:port. */
function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Bring the Firefox window owned by `pid` to the front. PID-targeted (rather
 * than by app name) so it works regardless of release channel, and can never
 * end up launching/activating an unrelated installed Firefox. */
export function focusFirefoxWindow(pid: number): void {
  switch (process.platform) {
    case "darwin":
      spawn(
        "osascript",
        [
          "-e",
          `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
        ],
        { stdio: "ignore" }
      );
      break;
  }
}

function bringToForeground(pid: number): void {
  setTimeout(() => focusFirefoxWindow(pid), 1500);
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, 0x1 /* fs.constants.X_OK */);
    return true;
  } catch {
    return false;
  }
}

export type FirefoxChannel = "release" | "beta" | "nightly";

/** Find a Firefox binary to launch for the given release channel.
 *
 * Release and Beta share the same branding (app name / install directory) on
 * both macOS and Windows, so there's no separate on-disk location to look for
 * Beta specifically there; only Nightly gets a distinct install location on
 * those platforms. Linux is the exception: Mozilla's official APT repo ships
 * "beta" and "nightly" as separate binaries, so those get dedicated paths. */
export function findFirefoxBinary(channel: FirefoxChannel = "release"): string | undefined {
  const candidates: string[] = [];
  switch (process.platform) {
    case "darwin":
      if (channel === "nightly") {
        candidates.push(
          "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
          join(homedir(), "Applications/Firefox Nightly.app/Contents/MacOS/firefox")
        );
      } else {
        candidates.push(
          "/Applications/Firefox.app/Contents/MacOS/firefox",
          join(homedir(), "Applications/Firefox.app/Contents/MacOS/firefox"),
          "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
        );
      }
      break;
    case "win32": {
      const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]];
      const dir = channel === "nightly" ? "Firefox Nightly" : "Mozilla Firefox";
      for (const base of pf) {
        if (base) candidates.push(join(base, dir, "firefox.exe"));
      }
      break;
    }
    default: // Linux and other Unix
      if (channel === "nightly") {
        candidates.push("/usr/bin/firefox-nightly", "/usr/local/bin/firefox-nightly");
      } else if (channel === "beta") {
        candidates.push("/usr/bin/firefox-beta", "/usr/local/bin/firefox-beta");
      } else {
        candidates.push("/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox");
      }
      break;
  }
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  // Fall back to PATH lookup.
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const bin = channel === "release" ? "firefox" : `firefox-${channel}`;
    const result = execFileSync(cmd, [bin], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const first = result.trim().split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    /* not in PATH */
  }
  return undefined;
}

const PROFILE_PREFS = [
  ["devtools.debugger.remote-enabled", true],
  ["devtools.chrome.enabled", true],
  ["devtools.debugger.prompt-connection", false],
  ["devtools.debugger.force-local", true],
  ["browser.shell.checkDefaultBrowser", false],
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["datareporting.policy.dataSubmissionPolicyBypassNotification", true],
  ["toolkit.telemetry.reportingpolicy.firstRun", false],
  ["browser.aboutwelcome.enabled", false],
  ["startup.homepage_welcome_url", ""],
  ["startup.homepage_welcome_url.additional", ""],
  ["javascript.options.wasm_js_promise_integration", true],
] as const;

/** Pref used to confirm an RDP connection actually reached the Firefox this
 * process launched, rather than an unrelated (e.g. stale leftover) instance
 * that happens to be listening on the same port. See verifyFirefoxLaunchToken. */
export const LAUNCH_TOKEN_PREF = "firefoxLldb.launchToken";

export interface FirefoxHandle {
  profileDir: string;
  exited: Promise<void>;
  close: () => Promise<void>;
  /** Random value written to LAUNCH_TOKEN_PREF in this launch's profile. */
  launchToken: string;
  /** PID of the launched Firefox process, for PID-targeted window focus. */
  pid: number | undefined;
}

export async function launchFirefox(opts: {
  rdpPort: number;
  binary?: string;
  /** Release channel to auto-detect a binary for when `binary` isn't given. */
  channel?: FirefoxChannel;
  headless?: boolean;
  url?: string;
  /** When set, also start Marionette on this port so a WebDriver-BiDi client
   * (e.g. firefox-devtools-mcp --connect-existing) can drive the same Firefox. */
  marionettePort?: number;
}): Promise<FirefoxHandle> {
  const binary = opts.binary ?? findFirefoxBinary(opts.channel);
  if (!binary) {
    throw new Error(
      `Firefox${opts.channel && opts.channel !== "release" ? ` (${opts.channel})` : ""} not found. ` +
        "Install it in a standard location or pass --firefox <path>."
    );
  }
  if (await isPortOpen(opts.rdpPort)) {
    throw new Error(
      `something is already listening on 127.0.0.1:${opts.rdpPort} (the RDP port). ` +
        `This is likely a leftover Firefox from a previous run — kill it or pass a different --rdp-port.`
    );
  }
  const profileDir = await mkdtemp(join(tmpdir(), "ff-rdp-"));
  const launchToken = randomUUID();

  let prefs =
    PROFILE_PREFS.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(
      "\n"
    ) +
    `\nuser_pref("devtools.debugger.remote-port", ${opts.rdpPort});\n` +
    `user_pref(${JSON.stringify(LAUNCH_TOKEN_PREF)}, ${JSON.stringify(launchToken)});\n`;
  if (opts.marionettePort !== undefined) {
    prefs += `user_pref("marionette.port", ${opts.marionettePort});\n`;
  }
  await writeFile(join(profileDir, "user.js"), prefs);

  const args = [
    "--no-remote",
    "--profile",
    profileDir,
    "--start-debugger-server",
    String(opts.rdpPort),
  ];
  // RDP (debugger server) and Marionette are independent and coexist; enabling
  // both lets one Firefox serve firefox-lldb (RDP) and a BiDi page driver.
  if (opts.marionettePort !== undefined) args.push("--marionette");
  args.push(opts.url ?? "about:blank");
  if (opts.headless ?? false) args.unshift("--headless");

  // detached: true makes the child a process group leader so we can kill
  // the whole group (Firefox + plugin-container children) with -pid on close.
  const child: ChildProcess = spawn(binary, args, { stdio: "ignore", detached: true });
  child.unref();

  if (!(opts.headless ?? false) && child.pid !== undefined) {
    bringToForeground(child.pid);
  }

  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  return {
    profileDir,
    exited,
    launchToken,
    pid: child.pid,
    close: async () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process may have already exited.
        }
      }
      // Wait for the process to actually die before returning, so a subsequent
      // launch in the same process doesn't race a still-alive Firefox.
      await exited;
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
