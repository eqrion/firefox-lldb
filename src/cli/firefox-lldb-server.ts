/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// LLDB platform server backed by Firefox over RDP.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { RspServer, type RspLogger } from "../protocol/rsp-server.js";
import {
  GdbServerSpawner,
  type GdbServerLauncher,
} from "../platform/gdb-server-spawner.js";
import { startAttachShim } from "../protocol/attach-shim.js";
import { PlatformServer } from "../platform/platform-server.js";
import {
  RdpWasmSession,
  listFirefoxTabs,
  watchAndPrimeFirefoxTabs,
  type TabInfo,
} from "../rdp/session.js";
import { setRdpTrace } from "../rdp/transport.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import { launchFirefox, type FirefoxHandle } from "../rdp/firefox.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";
import { consoleLogger } from "./logger.js";

const USAGE = `\
Usage: firefox-lldb-server [options]

Modes (default: --launch):
  --launch            Launch a fresh Firefox with a throwaway profile.
  --connect           Connect to an already-running Firefox.

Options:
  -p, --port <N>      Platform server RSP port (default: 1234).
  --rdp-port <N>      Firefox RDP port (default: 6080).
  --url <U>           URL navigated to when LLDB spawns a process (connect or
                      attach). Firefox itself starts on about:blank.
  --firefox <path>    Firefox binary (default: auto-detected from standard locations).
  --headless          Run Firefox headlessly.
  --fire <js>         Evaluate JS after the first breakpoint arms (test use).
  -v, --verbose       Log debug output.
  -h, --help          Show this message.

LLDB attach sequence:
  (lldb) platform select remote-gdb-server
  (lldb) platform connect connect://localhost:<port>
  (lldb) platform process list          # list open tabs
  (lldb) process attach --pid <N>       # attach to a wasm tab
`;

export interface Args {
  connect: boolean;
  headless: boolean;
  port: number;
  rdpPort: number;
  url?: string;
  firefox?: string;
  fire?: string;
  verbose: boolean;
}

export function parseCliArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        connect: { type: "boolean" },
        launch: { type: "boolean" },
        headless: { type: "boolean" },
        port: { type: "string", short: "p" },
        "rdp-port": { type: "string" },
        url: { type: "string" },
        firefox: { type: "string" },
        fire: { type: "string" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\ntry --help for usage.\n`);
    process.exit(1);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const port = Number(values.port ?? 1234);
  const rdpPort = Number(values["rdp-port"] ?? 6080);
  if (Number.isNaN(port)) {
    process.stderr.write(`error: --port must be a number, got "${values.port}"\n`);
    process.exit(1);
  }
  if (Number.isNaN(rdpPort)) {
    process.stderr.write(`error: --rdp-port must be a number, got "${values["rdp-port"]}"\n`);
    process.exit(1);
  }

  return {
    connect: values.launch ? false : !!values.connect,
    headless: !!values.headless,
    port,
    rdpPort,
    url: values.url,
    firefox: values.firefox,
    fire: values.fire,
    verbose: !!values.verbose,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(rdpPort: number, tabActor?: string): Promise<RdpWasmSession> {
  let lastErr: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      return await RdpWasmSession.start(rdpPort, "127.0.0.1", tabActor);
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`could not connect to Firefox RDP on ${rdpPort}: ${msg}`);
}

async function watchTabs(
  rdpPort: number,
  onTabs: (tabs: TabInfo[]) => void,
  shouldStop: () => boolean = () => false
): Promise<void> {
  while (!shouldStop()) {
    try {
      await watchAndPrimeFirefoxTabs(rdpPort, "127.0.0.1", onTabs);
    } catch {
      // Connection error; fall through to the sleep+retry below.
    }
    // Whether the RDP connection closed cleanly or with an error, retry after
    // a short delay so --connect mode recovers when Firefox restarts.
    if (!shouldStop()) await sleep(250);
  }
}

async function waitForWasm(
  session: RdpWasmSession,
  onWaiting?: () => void
): Promise<void> {
  // Abort early if the session closes so we don't poll for 30 s on a dead
  // connection (wasmSources() catches errors and returns [], but sleep(100)
  // still runs each iteration without this guard).
  let sessionClosed = false;
  const onClose = () => { sessionClosed = true; };
  session.on("close", onClose);
  try {
    let wasm = (await session.wasmSources())[0];
    let notified = false;
    for (let i = 0; i < 300 && !wasm && !sessionClosed; i++) {
      if (!notified && i === 20) {
        notified = true;
        onWaiting?.();
      }
      await sleep(100);
      wasm = (await session.wasmSources())[0];
    }
    if (!wasm) throw new Error(sessionClosed ? "session closed" : "no wasm source appeared");
  } finally {
    session.off("close", onClose);
  }
}

export interface StartOptions {
  /** Bridge the per-tab GDB server port (see PlatformServerDeps.wrapConnectPort). */
  wrapConnectPort?: (port: number) => Promise<number>;
  /** Override the logger (the in-process embedding uses a quieter one). */
  logger?: RspLogger;
  /** Called once per newly-seen tab with a non-blank URL. Defaults to printing
   * a `process attach --plugin wasm --pid N` hint to stderr (for native lldb). */
  onTab?: (tab: TabInfo, pid: number) => void;
  /** Called with each per-tab RDP session as it is created (the in-process
   * embedding uses this to drive `js` commands and console streaming). */
  onSession?: (session: RdpWasmSession) => void;
}

export interface PlatformServerHandle {
  port: number;
  platformServer: PlatformServer;
  spawner: GdbServerSpawner;
  shutdown: () => Promise<void>;
  /** Resolves when a launched Firefox exits (undefined in --connect mode). */
  firefoxExited?: Promise<void>;
}

// Bring up Firefox (if launching), the per-tab GDB server launcher, and the
// platform RSP server. Returns once the server is listening. Used by both the
// standalone CLI and the in-process wasm embedding.
export async function startPlatformServer(
  args: Args,
  opts: StartOptions = {}
): Promise<PlatformServerHandle> {
  const verbose = args.verbose || process.env.DEBUG === "1";
  const logger = opts.logger ?? consoleLogger(verbose);
  setRdpTrace(verbose);
  const launching = !args.connect;

  let firefox: FirefoxHandle | undefined;
  if (launching) {
    firefox = await launchFirefox({
      rdpPort: args.rdpPort,
      binary: args.firefox,
      headless: args.headless,
      // NOTE: deliberately not passing url here. Firefox starts on about:blank;
      // the tab is navigated to the page lazily on the first qLaunchGDBServer
      // (see the launcher below). Launching Firefox directly at the page would
      // make that navigate a redundant reload of an already-loaded tab.
    });
    logger.info("launched Firefox");
  }

  // currentTabs is updated by the watcher below and read by the platform server
  // to satisfy `platform process list` and resolve `process attach --pid N`.
  let currentTabs: TabInfo[] = [];

  const launcher: GdbServerLauncher = async ({ port, url, tabActor }) => {
    // Actor IDs are scoped to an RDP connection. The watcher uses a separate
    // connection from the launcher, so re-resolve by position in currentTabs.
    let resolvedActor = tabActor;
    if (tabActor) {
      const idx = currentTabs.findIndex((t) => t.actor === tabActor);
      if (idx !== -1) {
        const fresh = await listFirefoxTabs(args.rdpPort).catch(() => currentTabs);
        resolvedActor = fresh[idx]?.actor ?? tabActor;
      }
    }

    const session = launching
      ? await connectWithRetry(args.rdpPort, resolvedActor)
      : await RdpWasmSession.start(args.rdpPort, "127.0.0.1", resolvedActor);
    opts.onSession?.(session);

    // Close the session on any failure past this point; otherwise a launch that
    // throws (e.g. waitForWasm times out) leaks the RDP watcher connection, and
    // a retried qLaunchGDBServer accumulates dead sessions against Firefox.
    try {
      // Navigate to the target page when needed. The watcher connection runs
      // watchAndPrimeFirefoxTabs which sets observeWasm:true on the tab before
      // any page loads; pages navigated after that compile wasm in debug mode
      // automatically. A navigation is only needed when:
      //   - an explicit url came from qLaunchGDBServer (e.g. `process launch`), or
      //   - no wasm is loaded yet and --url is configured (initial page load), or
      //   - wasm IS loaded but has empty breakpoint positions (not in debug mode,
      //     which can happen if it loaded before the priming connection was ready).
      const wasm0 = await session.wasmSources();
      const inDebugMode =
        wasm0.length > 0 && (await session.wasmBreakpointOffsets(wasm0[0].actor)).length > 0;
      const tabUrl = session.topLevelUrl();
      const navTo =
        url ??
        (!wasm0.length
          ? args.url
          : !inDebugMode
            ? (args.url ?? (tabUrl && tabUrl !== "about:blank" ? tabUrl : undefined))
            : undefined);
      if (navTo) {
        await session.navigate(navTo);
        logger.debug(`[rdp] navigated to ${navTo}`);
        await waitForWasm(session, () => logger.info("waiting for wasm sources to appear..."));
      } else if (!session.hasThreads()) {
        await sleep(500);
      }

      const fire = args.fire;
      const onFirstContinue = fire
        ? () => {
            const wrapped = `(function poll(){try{${fire}}catch(e){setTimeout(poll,20);}})()`;
            session.evaluate(wrapped).catch(() => {});
          }
        : undefined;

      const debuggee = new RdpDebuggee(session, onFirstContinue ? { onFirstContinue } : undefined);

      // Force a genuine RDP all-stop and snapshot before the component starts.
      // The component's startup update_on_stop reads the stop state once; priming
      // here means it captures a real pause with real frames instead of a
      // synthetic "stopped" with no pause behind it (issue #21).
      if (session.hasThreads()) await debuggee.primeStop();

      // The component presents an already-attached, stopped process on connect,
      // which works for `process connect` but breaks LLDB's `process attach`
      // (its ClearAllLoadedSections wipes the connect-time module relocation).
      // So the component listens on a private port and an RSP shim fronts the
      // public `port`, emulating an unattached server until `vAttach` (see
      // attach-shim.ts). LLDB then drives the native attach handshake and
      // `process attach --plugin wasm` works.
      // Use port 0 so the OS assigns the component port — avoids the
      // TOCTOU race that freePort() has (grab-port → close → bind).
      const gdbServer = startGdbServer({
        dispatch: (req: unknown) => debuggee.dispatch(req as never),
        port: 0,
        onInfo: (m: string) => logger.debug(`[component] ${m}`),
        verbose,
      });
      await gdbServer.ready;
      const shim = await startAttachShim({
        listenPort: port,
        componentPort: gdbServer.port,
        trace: verbose ? (m) => logger.debug(`[shim] ${m}`) : undefined,
      });
      return {
        port: shim.port,
        stop: async () => {
          await shim.close();
          gdbServer.stop();
          session.close();
        },
      };
    } catch (err) {
      session.close();
      throw err;
    }
  };

  const spawner = new GdbServerSpawner(launcher);
  const platformServer = new PlatformServer({
    spawner,
    defaultUrl: args.url,
    listTabs: async () => currentTabs,
    wrapConnectPort: opts.wrapConnectPort,
  });
  const server = new RspServer(platformServer, { logger });

  const bound = await server.listen(args.port);

  if (!launching) {
    listFirefoxTabs(args.rdpPort).catch(() =>
      logger.warn(
        `could not reach Firefox RDP on port ${args.rdpPort} — is Firefox running with --start-debugger-server ${args.rdpPort}?`
      )
    );
  }

  // Default hint suits a native lldb client (no `attach` alias defined).
  const onTab =
    opts.onTab ??
    ((tab: TabInfo, pid: number) =>
      process.stderr.write(
        `\n[info] tab available: ${tab.url}\n` +
          `[info]   process attach --plugin wasm --pid ${pid}\n`
      ));

  let stopped = false;
  const hinted = new Set<string>();
  void watchTabs(
    args.rdpPort,
    (tabs) => {
      currentTabs = tabs;
      for (const tab of tabs) {
        if (!hinted.has(tab.actor) && tab.url && tab.url !== "about:blank") {
          hinted.add(tab.actor);
          onTab(tab, platformServer.tabPid(tab.actor));
        }
      }
    },
    () => stopped
  );

  const shutdown = async () => {
    stopped = true;
    await spawner.killAll();
    await server.close();
    await firefox?.close();
  };

  return { port: bound, platformServer, spawner, shutdown, firefoxExited: firefox?.exited };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const handle = await startPlatformServer(args);
  // Stdout is the control channel for the firefox-lldb wrapper; stderr carries logs.
  process.stdout.write(`platform server ready on connect://localhost:${handle.port}\n`);

  const onSignal = () => void handle.shutdown().then(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", () => {});

  // When launched session-detached (e.g. the e2e harness uses setsid), a killed
  // parent does not signal us, so we would orphan the launched Firefox. Poll for
  // reparenting to init/launchd (ppid 1) and shut down cleanly when it happens.
  if (process.env.FIREFOX_LLDB_EXIT_WHEN_ORPHANED) {
    const timer = setInterval(() => {
      if (process.ppid === 1) {
        void handle.shutdown().then(() => process.exit(0));
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
