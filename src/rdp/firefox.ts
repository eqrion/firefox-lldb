/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Launch a headless Firefox with an isolated, throwaway profile and the RDP
// debugger server enabled. Used by the live test bridge so an lldb test can
// debug real wasm in a real browser without touching the user's Firefox.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { accessSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

function bringToForeground(pid: number): void {
  switch (process.platform) {
    case "darwin":
      setTimeout(
        () =>
          spawn(
            "osascript",
            [
              "-e",
              `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
            ],
            { stdio: "ignore" }
          ),
        1500
      );
      break;
  }
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, 0x1 /* fs.constants.X_OK */);
    return true;
  } catch {
    return false;
  }
}

/** Find a Firefox binary to launch, preferring stable over Nightly. */
export function findFirefoxBinary(): string | undefined {
  const candidates: string[] = [];
  switch (process.platform) {
    case "darwin":
      candidates.push(
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        join(homedir(), "Applications/Firefox.app/Contents/MacOS/firefox"),
        "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
      );
      break;
    case "win32": {
      const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]];
      for (const base of pf) {
        if (base) candidates.push(join(base, "Mozilla Firefox", "firefox.exe"));
      }
      break;
    }
    default: // Linux and other Unix
      candidates.push("/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox");
      break;
  }
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  // Fall back to PATH lookup.
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["firefox"], {
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

export interface FirefoxHandle {
  profileDir: string;
  exited: Promise<void>;
  close: () => Promise<void>;
}

export async function launchFirefox(opts: {
  rdpPort: number;
  binary?: string;
  headless?: boolean;
  url?: string;
  /** When set, also start Marionette on this port so a WebDriver-BiDi client
   * (e.g. firefox-devtools-mcp --connect-existing) can drive the same Firefox. */
  marionettePort?: number;
}): Promise<FirefoxHandle> {
  const binary = opts.binary ?? findFirefoxBinary();
  if (!binary) {
    throw new Error(
      "Firefox not found. Install Firefox in a standard location or pass --firefox <path>."
    );
  }
  const profileDir = await mkdtemp(join(tmpdir(), "ff-rdp-"));

  let prefs =
    PROFILE_PREFS.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(
      "\n"
    ) + `\nuser_pref("devtools.debugger.remote-port", ${opts.rdpPort});\n`;
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
