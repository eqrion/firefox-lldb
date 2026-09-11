/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns a launched Firefox, its profile changes and verified process cleanup.
// Existing browsers reached through --connect are owned by their caller.

import { spawn, execFileSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { accessSync, existsSync, readFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { firefoxLogDir } from "../config.js";
import { noopLogger, type Logger } from "../diagnostics/logger.js";
import { stopFirefoxReplacements } from "./firefox-processes.js";
import { LAUNCH_TOKEN_PREF } from "../rdp/constants.js";

export class FirefoxPortInUseError extends Error {
  constructor(port: number) {
    super(`RDP port 127.0.0.1:${port} is already in use; choose another --rdp-port`);
    this.name = "FirefoxPortInUseError";
  }
}

/** Check binding directly, without sending a probe connection to an unrelated service. */
function checkPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new FirefoxPortInUseError(port) : error);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
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
      ).on("error", () => {
        // Window focus is best-effort and must never take down a debug session.
      });
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

function profilesIniPath(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library/Application Support/Firefox/profiles.ini");
    case "win32":
      return join(process.env["APPDATA"] ?? homedir(), "Mozilla/Firefox/profiles.ini");
    default:
      return join(homedir(), ".mozilla/firefox/profiles.ini");
  }
}

function parseIni(text: string): Record<string, string>[] {
  const sections: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (/^\[.*\]$/.test(line)) {
      current = {};
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || !current) continue;
    current[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return sections;
}

/** Resolve the directory of the real, persistent default profile Firefox uses
 * for `channel` when launched normally. Since Firefox 67, each install gets a
 * dedicated profile named "<salt>.default-<updateChannel>" (see
 * nsToolkitProfileService::CreateDefaultProfile); fall back to the legacy
 * Default=1 profile if no dedicated one is found. */
export function findDefaultProfileDir(channel: FirefoxChannel = "release"): string | undefined {
  const iniPath = profilesIniPath();
  let ini: string;
  try {
    ini = readFileSync(iniPath, "utf8");
  } catch {
    return undefined;
  }
  const sections = parseIni(ini);
  const resolve = (path: string, isRelative: string | undefined) =>
    isRelative !== "0" ? join(dirname(iniPath), path) : path;

  const dedicated = sections.find((s) => s.Path?.endsWith(`.default-${channel}`));
  if (dedicated) return resolve(dedicated.Path!, dedicated.IsRelative);

  const legacyDefault = sections.find((s) => s.Default === "1" && s.Path);
  return legacyDefault ? resolve(legacyDefault.Path!, legacyDefault.IsRelative) : undefined;
}

/** True if another Firefox process currently holds `profileDir` (best-effort:
 * checks for the lock file/symlink Firefox creates while running). */
function isProfileLocked(profileDir: string): boolean {
  return existsSync(join(profileDir, ".parentlock")) || existsSync(join(profileDir, "parent.lock"));
}

const MARKER_START = "// >>> firefox-lldb (auto-generated; safe to delete) >>>";
const MARKER_END = "// <<< firefox-lldb <<<";

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function stripMarkedBlock(content: string): string {
  const start = content.indexOf(MARKER_START);
  if (start === -1) return content;
  const end = content.indexOf(MARKER_END, start);
  return end === -1
    ? content.slice(0, start)
    : content.slice(0, start) + content.slice(end + MARKER_END.length);
}

/** Merge `prefsBlock` into profileDir/user.js inside a marker-delimited
 * block, replacing any block a previous (e.g. crashed) run left behind. */
async function writeUserJsBlock(profileDir: string, prefsBlock: string): Promise<void> {
  const path = join(profileDir, "user.js");
  const existing = await readOptionalFile(path);
  const cleaned = stripMarkedBlock(existing ?? "");
  await writeFile(path, `${cleaned}\n${MARKER_START}\n${prefsBlock}${MARKER_END}\n`);
}

/** Undo writeUserJsBlock: remove our block, deleting user.js if that leaves it empty. */
async function removeUserJsBlock(profileDir: string): Promise<void> {
  const path = join(profileDir, "user.js");
  const existing = await readOptionalFile(path);
  if (existing === undefined) return;
  const cleaned = stripMarkedBlock(existing).trim();
  if (cleaned === "") await rm(path, { force: true }).catch(() => {});
  else await writeFile(path, cleaned + "\n");
}

// Prefs Firefox itself requires for --start-debugger-server to do anything
// (DevToolsStartup.sys.mjs checks these before honoring the flag), plus the
// port/token prefs identifying this launch. Always applied.
const REQUIRED_DEBUG_PREFS = [
  ["devtools.debugger.remote-enabled", true],
  ["devtools.chrome.enabled", true],
  ["devtools.debugger.prompt-connection", false],
  ["devtools.debugger.force-local", true],
] as const;

// Convenience prefs that make an ephemeral profile pleasant to automate
// against (skip telemetry prompts, welcome screens, etc). Only applied to a
// throwaway profile — never to the user's real default profile.
const CONVENIENCE_PREFS = [
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
  /** Random value written to LAUNCH_TOKEN_PREF in this launch's profile. */
  launchToken: string;
  /** PID of the launched Firefox process, for PID-targeted window focus. */
  pid: number | undefined;
}

// Two waits are possible; keep their combined bound below the harness's
// independent 10-second best-effort shutdown deadline.
const FIREFOX_CLOSE_GRACE_MS = 3_000;

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  /** Reuse the channel's real default profile (history, logins, extensions)
   * instead of a throwaway one. Firefox can't run two instances against the
   * same profile, so this fails if that profile is already running. */
  defaultProfile?: boolean;
  logger?: Logger;
  /** Cancels acquisition; rejection joins cleanup before returning. */
  signal?: AbortSignal;
}): Promise<FirefoxHandle> {
  opts.signal?.throwIfAborted();
  const logger = opts.logger ?? noopLogger;
  const binary = opts.binary ?? findFirefoxBinary(opts.channel);
  if (!binary) {
    throw new Error(
      `Firefox${opts.channel && opts.channel !== "release" ? ` (${opts.channel})` : ""} not found. ` +
        "Install it in a standard location or pass --firefox <path>."
    );
  }
  await checkPortAvailable(opts.rdpPort);
  opts.signal?.throwIfAborted();

  let profileDir: string;
  if (opts.defaultProfile) {
    const channel = opts.channel ?? "release";
    const found = findDefaultProfileDir(channel);
    if (!found) {
      throw new Error(
        `could not find a default profile for the ${channel} channel. ` +
          "Run that Firefox once normally first, or drop --default-profile."
      );
    }
    if (isProfileLocked(found)) {
      throw new Error(
        `Firefox is already running with its default profile (${found}). ` +
          "Close it first, or drop --default-profile to use a throwaway one."
      );
    }
    profileDir = found;
    process.stderr.write(
      `warning: --default-profile writes debug prefs into your real Firefox profile at ` +
        `${profileDir} (removed again on clean exit).\n`
    );
  } else {
    profileDir = await mkdtemp(join(tmpdir(), "ff-rdp-"));
  }
  const launchToken = randomUUID();

  const prefList = opts.defaultProfile
    ? REQUIRED_DEBUG_PREFS
    : [...REQUIRED_DEBUG_PREFS, ...CONVENIENCE_PREFS];
  let prefs =
    prefList.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") +
    `\nuser_pref("devtools.debugger.remote-port", ${opts.rdpPort});\n` +
    `user_pref(${JSON.stringify(LAUNCH_TOKEN_PREF)}, ${JSON.stringify(launchToken)});\n`;
  if (opts.marionettePort !== undefined) {
    prefs += `user_pref("marionette.port", ${opts.marionettePort});\n`;
  }
  let wroteProfile = false;
  const rollbackProfile = async (error: unknown): Promise<never> => {
    try {
      if (opts.defaultProfile) {
        if (wroteProfile) await removeUserJsBlock(profileDir);
      } else await rm(profileDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Firefox startup and profile rollback failed: ${profileDir}`
      );
    }
    throw error;
  };
  try {
    logger.debug(`[firefox] launch.profile-acquired ${JSON.stringify({ profileDir })}`);
    opts.signal?.throwIfAborted();
    wroteProfile = true;
    if (opts.defaultProfile) {
      await writeUserJsBlock(profileDir, prefs);
    } else {
      await writeFile(join(profileDir, "user.js"), prefs);
    }
  } catch (err) {
    return rollbackProfile(err);
  }

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
  const logDir = firefoxLogDir();
  let captureOutput = false;
  if (logDir) {
    try {
      await mkdir(logDir, { recursive: true });
      captureOutput = true;
    } catch (err) {
      process.stderr.write(
        `warning: could not create Firefox log directory ${logDir}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }
  const stdio: StdioOptions = captureOutput ? ["ignore", "pipe", "pipe"] : "ignore";
  let child: ChildProcess;
  try {
    opts.signal?.throwIfAborted();
    child = spawn(binary, args, { stdio, detached: true });
  } catch (err) {
    return rollbackProfile(err);
  }
  // Some Firefox launchers (notably macOS Nightly) hand off to the browser
  // process and exit almost immediately. Subscribe before doing any other
  // work with the child: otherwise it can exit between spawn() and the
  // listener below, leaving close() waiting forever for an event it missed.
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", () => resolve());
      // Node does not guarantee an "exit" event when spawning fails.
      child.once("error", () => resolve());
    }
  });
  const stdioClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let outputLog: ReturnType<typeof createWriteStream> | undefined;
  let outputClosed: Promise<void> = Promise.resolve();
  if (captureOutput && logDir) {
    outputLog = createWriteStream(join(logDir, `firefox-${launchToken}.log`));
    outputClosed = new Promise<void>((resolve) => {
      outputLog!.once("close", resolve);
      outputLog!.once("error", () => resolve());
    });
    outputLog.on("error", (err) => {
      process.stderr.write(`warning: could not write Firefox log: ${err.message}\n`);
    });
    // Child 'exit' precedes pipe drainage. Only 'close' proves both streams
    // reached EOF, including pipes inherited by a replacement browser.
    child.stdout?.pipe(outputLog, { end: false });
    child.stderr?.pipe(outputLog, { end: false });
    void stdioClosed.then(() => outputLog?.end());
  }
  try {
    await started;
  } catch (err) {
    await exitsWithin(outputClosed, FIREFOX_CLOSE_GRACE_MS);
    outputLog?.destroy();
    return rollbackProfile(
      new Error(
        `could not start Firefox (${binary}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    );
  }
  child.unref();
  logger.debug(
    `[firefox] launch.spawned ${JSON.stringify({
      pid: child.pid,
      profileDir,
      rdpPort: opts.rdpPort,
      launchToken,
    })}`
  );
  void exited.then(() =>
    logger.debug(
      `[firefox] launcher.exited ${JSON.stringify({
        pid: child.pid,
        code: child.exitCode,
        signal: child.signalCode,
      })}`
    )
  );

  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      clearTimeout(focusTimer);
      // launchFirefox deliberately unrefs the detached browser so an abandoned
      // handle cannot keep its caller alive forever. Once close() is awaited,
      // however, the child exit event is the work the caller is waiting for;
      // keep it referenced until that event arrives. Without this, a short
      // standalone caller can exhaust its other handles after SIGKILL and Node
      // exits with its close promise still pending.
      child.ref();
      let groupKillFailed = false;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          groupKillFailed = true;
        }
        // A launcher can move out of the process group it originally led.
        // Fall back to its direct PID when the group no longer exists.
        if (groupKillFailed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may have already exited.
          }
        }
      }
      // Wait for the process to actually die before returning, so a subsequent
      // launch in the same process doesn't race a still-alive Firefox.
      let didExit = await exitsWithin(exited, FIREFOX_CLOSE_GRACE_MS);
      if (!didExit) {
        // A successful process-group signal still does not guarantee that the
        // original launcher will deliver an exit event. Try the direct child
        // once, then make failure bounded and release every referenced pipe.
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited.
        }
        didExit = await exitsWithin(exited, FIREFOX_CLOSE_GRACE_MS);
      }
      if (!didExit) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        outputLog?.destroy();
        child.unref();
        throw new Error(
          `Firefox process ${child.pid ?? "unknown"} did not exit after two SIGKILL attempts`
        );
      }
      // macOS can relaunch through Launch Services into a new PID and process
      // group. The original child's exit proves nothing about that replacement.
      // Keep the profile if discovery or termination cannot be verified.
      if (process.platform !== "win32") {
        try {
          await stopFirefoxReplacements(profileDir, opts.rdpPort, logger);
        } catch (error) {
          logger.error(`[firefox] cleanup.failed profile=${profileDir}: ${String(error)}`);
          child.stdout?.destroy();
          child.stderr?.destroy();
          outputLog?.destroy();
          child.unref();
          throw error;
        }
      }
      if (!(await exitsWithin(outputClosed, FIREFOX_CLOSE_GRACE_MS))) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        outputLog?.destroy();
        throw new Error(
          `Firefox output did not drain; transcript incomplete for profile ${profileDir}`
        );
      }
      if (opts.defaultProfile) {
        await removeUserJsBlock(profileDir);
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
    })());

  if (opts.signal?.aborted) {
    try {
      await close();
    } catch (error) {
      throw new AggregateError(
        [opts.signal.reason, error],
        "Firefox cancellation and rollback failed"
      );
    }
    opts.signal.throwIfAborted();
  }
  if (!(opts.headless ?? false) && child.pid !== undefined) {
    const pid = child.pid;
    focusTimer = setTimeout(() => focusFirefoxWindow(pid), 1500);
  }
  return {
    profileDir,
    exited,
    launchToken,
    pid: child.pid,
    close,
  };
}
