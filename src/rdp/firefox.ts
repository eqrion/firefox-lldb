// Launch a headless Firefox with an isolated, throwaway profile and the RDP
// debugger server enabled. Used by the live test bridge so an lldb test can
// debug real wasm in a real browser without touching the user's Firefox.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stable Firefox (not Nightly — never disturb a running Nightly profile).
const DEFAULT_FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";

const PROFILE_PREFS = [
  ["devtools.debugger.remote-enabled", true],
  ["devtools.chrome.enabled", true],
  ["devtools.debugger.prompt-connection", false],
  ["devtools.debugger.force-local", true],
  ["browser.shell.checkDefaultBrowser", false],
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["toolkit.telemetry.reportingpolicy.firstRun", false],
] as const;

export interface FirefoxHandle {
  profileDir: string;
  close: () => Promise<void>;
}

export async function launchFirefox(opts: {
  rdpPort: number;
  binary?: string;
  headless?: boolean;
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
    "about:blank",
  ];
  if (opts.headless ?? true) args.unshift("--headless");

  const child: ChildProcess = spawn(binary, args, { stdio: "ignore" });

  return {
    profileDir,
    close: async () => {
      child.kill("SIGKILL");
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
