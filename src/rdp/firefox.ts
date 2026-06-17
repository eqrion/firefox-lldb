/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Launch a headless Firefox with an isolated, throwaway profile and the RDP
// debugger server enabled. Used by the live test bridge so an lldb test can
// debug real wasm in a real browser without touching the user's Firefox.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// Stable Firefox (not Nightly — never disturb a running Nightly profile).
const DEFAULT_FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";

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
}): Promise<FirefoxHandle> {
  const binary = opts.binary ?? DEFAULT_FIREFOX;
  const profileDir = await mkdtemp(join(tmpdir(), "ff-rdp-"));

  const prefs =
    PROFILE_PREFS.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(
      "\n"
    ) + `\nuser_pref("devtools.debugger.remote-port", ${opts.rdpPort});\n`;
  await writeFile(join(profileDir, "user.js"), prefs);

  const args = [
    "--no-remote",
    "--profile",
    profileDir,
    "--start-debugger-server",
    String(opts.rdpPort),
    opts.url ?? "about:blank",
  ];
  if (opts.headless ?? false) args.unshift("--headless");

  const child: ChildProcess = spawn(binary, args, { stdio: "ignore" });

  if (!(opts.headless ?? false) && child.pid !== undefined) {
    bringToForeground(child.pid);
  }

  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

  return {
    profileDir,
    exited,
    close: async () => {
      child.kill("SIGKILL");
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
