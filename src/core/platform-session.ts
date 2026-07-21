/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared bring-up core: Firefox + the per-tab GDB server launcher + the
// platform RSP server. Used by both CLI entry points (the primary in-process
// wasm-LLDB embedding and the standalone server for an external native lldb).

import { parseArgs } from "node:util";
import { RspServer } from "../protocol/rsp-server.js";
import type { Logger } from "../logging.js";
import { GdbServerSpawner, type GdbServerLauncher } from "../platform/gdb-server-spawner.js";
import { startAttachShim } from "../protocol/attach-shim.js";
import { PlatformServer } from "../platform/platform-server.js";
import {
  RdpWasmSession,
  listFirefoxTabs,
  watchAndPrimeFirefoxTabs,
  verifyFirefoxLaunchToken,
  type TabInfo,
} from "../rdp/session.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import { launchFirefox, type FirefoxChannel, type FirefoxHandle } from "../rdp/firefox.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";
import { consoleLogger } from "../cli/logger.js";
import { debugEnvEnabled } from "../config.js";

const MAX_TRACE_CHARS = 4096;

function boundedTrace(message: string): string {
  if (message.length <= MAX_TRACE_CHARS) return message;
  return `${message.slice(0, MAX_TRACE_CHARS)}… [${message.length - MAX_TRACE_CHARS} chars omitted]`;
}

const USAGE = `\
Usage: firefox-lldb-server [options]

Modes (default: --launch):
  --launch            Launch a fresh Firefox with a throwaway profile.
  --connect           Connect to an already-running Firefox.

Options:
  -p, --port <N>      Platform server RSP port (default: 1234).
  --rdp-port <N>      Firefox RDP port (default: 6080).
  --marionette-port <N>  Also start Marionette on this port (for a BiDi page
                      driver like firefox-devtools-mcp). Off by default.
  --url <U>           URL navigated to when LLDB spawns a process (connect or
                      attach). Firefox itself starts on about:blank.
  --firefox <path>    Firefox binary (default: auto-detected from standard locations).
  --beta              Auto-detect and launch the Beta channel instead of stable.
  --nightly           Auto-detect and launch the Nightly channel instead of stable.
  --default-profile   Reuse the channel's real default profile (history, logins,
                      extensions) instead of a throwaway one. Fails if that
                      profile is already running elsewhere.
  --headless          Run Firefox headlessly.
  --fire <js>         Evaluate JS after the first breakpoint arms (test use).
  -v, --verbose       Log debug output (may include page/protocol data).
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
  marionettePort?: number;
  url?: string;
  firefox?: string;
  channel: FirefoxChannel;
  defaultProfile: boolean;
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
        "marionette-port": { type: "string" },
        url: { type: "string" },
        firefox: { type: "string" },
        beta: { type: "boolean" },
        nightly: { type: "boolean" },
        "default-profile": { type: "boolean" },
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
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(
      `error: --port must be an integer from 0 to 65535, got "${values.port}"\n`
    );
    process.exit(1);
  }
  if (!Number.isInteger(rdpPort) || rdpPort < 1 || rdpPort > 65535) {
    process.stderr.write(
      `error: --rdp-port must be an integer from 1 to 65535, got "${values["rdp-port"]}"\n`
    );
    process.exit(1);
  }
  let marionettePort: number | undefined;
  if (values["marionette-port"] !== undefined) {
    marionettePort = Number(values["marionette-port"]);
    if (!Number.isInteger(marionettePort) || marionettePort < 1 || marionettePort > 65535) {
      process.stderr.write(
        `error: --marionette-port must be an integer from 1 to 65535, got "${values["marionette-port"]}"\n`
      );
      process.exit(1);
    }
  }
  if (values.beta && values.nightly) {
    process.stderr.write("error: --beta and --nightly are mutually exclusive\n");
    process.exit(1);
  }
  if (values.firefox && (values.beta || values.nightly)) {
    process.stderr.write("error: --firefox already specifies a binary; drop --beta/--nightly\n");
    process.exit(1);
  }
  const channel: FirefoxChannel = values.beta ? "beta" : values.nightly ? "nightly" : "release";

  return {
    connect: values.launch ? false : !!values.connect,
    headless: !!values.headless,
    port,
    rdpPort,
    marionettePort,
    url: values.url,
    firefox: values.firefox,
    channel,
    defaultProfile: !!values["default-profile"],
    fire: values.fire,
    verbose: !!values.verbose,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(
  rdpPort: number,
  tabActor: string | undefined,
  logger: Logger
): Promise<RdpWasmSession> {
  let lastErr: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      return await RdpWasmSession.start(rdpPort, "127.0.0.1", tabActor, logger);
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
  logger: Logger,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      await watchAndPrimeFirefoxTabs(rdpPort, "127.0.0.1", onTabs, logger, signal);
    } catch (err) {
      // Connection error; fall through to the sleep+retry below.
      logger.debug(
        `[rdp] tab watcher reconnecting after: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Whether the RDP connection closed cleanly or with an error, retry after
    // a short delay so --connect mode recovers when Firefox restarts.
    if (!signal.aborted) await sleep(250);
  }
}

export interface StartOptions {
  /** Bridge the per-tab GDB server port (see PlatformServerDeps.wrapConnectPort). */
  wrapConnectPort?: (port: number) => Promise<number>;
  /** Override the logger (the in-process embedding uses a quieter one). */
  logger?: Logger;
  /** Called once per newly-seen tab with a non-blank URL. Defaults to printing
   * a `process attach --plugin wasm --pid N` hint to stderr (for native lldb). */
  onTab?: (tab: TabInfo, pid: number) => void;
  /** Called with each per-tab RDP session as it is created (the in-process
   * embedding uses this to drive `js` commands and console streaming).
   * The second argument interrupts the running target: sends RDP pauses to all
   * threads and immediately unblocks the gdbstub's EventFuture.finish. */
  onSession?: (session: RdpWasmSession, interrupt: () => void) => void;
}

export interface PlatformServerHandle {
  port: number;
  platformServer: PlatformServer;
  spawner: GdbServerSpawner;
  shutdown: () => Promise<void>;
  /** Resolves when a launched Firefox exits (undefined in --connect mode). */
  firefoxExited?: Promise<void>;
  /** PID of the launched Firefox (undefined in --connect mode). */
  firefoxPid?: number;
}

// Assembles the per-tab attach sequence run by qLaunchGDBServer: resolve the
// tab, navigate/prime it if needed, build the RdpDebuggee, prime a real stop,
// then boot the per-tab component + attach shim.
function createTabLauncher(
  args: Args,
  opts: StartOptions,
  logger: Logger,
  launching: boolean,
  verbose: boolean,
  getCurrentTabs: () => TabInfo[]
): GdbServerLauncher {
  return async ({ port, url, tabActor }) => {
    // Actor IDs are scoped to an RDP connection. The watcher uses a separate
    // connection from the launcher, so re-resolve by position in currentTabs.
    let resolvedActor = tabActor;
    if (tabActor) {
      const currentTabs = getCurrentTabs();
      const idx = currentTabs.findIndex((t) => t.actor === tabActor);
      if (idx !== -1) {
        const fresh = await listFirefoxTabs(args.rdpPort).catch((err) => {
          logger.debug(
            `[rdp] could not refresh tab actors: ${err instanceof Error ? err.message : String(err)}`
          );
          return currentTabs;
        });
        resolvedActor = fresh[idx]?.actor ?? tabActor;
      }
    }

    const session = launching
      ? await connectWithRetry(args.rdpPort, resolvedActor, logger)
      : await RdpWasmSession.start(args.rdpPort, "127.0.0.1", resolvedActor, logger);
    let debuggee: RdpDebuggee | undefined;
    let gdbServer: ReturnType<typeof startGdbServer> | undefined;

    // Close the session on any failure past this point; otherwise a launch that
    // throws leaks the RDP watcher connection, and a retried qLaunchGDBServer
    // accumulates dead sessions against Firefox.
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
        // Attach as soon as the page has loaded — do not wait for wasm to
        // compile. Some pages load wasm lazily or never; waiting here adds
        // latency to every attach and can push a content-heavy page past
        // LLDB's own attach timeout. #allModules() re-queries wasmSources()
        // on every stop, so a module that compiles after attach is picked
        // up automatically once the target stops again.
      } else if (!session.hasThreads()) {
        await sleep(500);
      }

      const fire = args.fire;
      const onFirstContinue = fire
        ? () => {
            const wrapped = `(function poll(){try{${fire}}catch(e){setTimeout(poll,20);}})()`;
            session
              .evaluate(wrapped)
              .catch((err) =>
                logger.debug(
                  `[rdp] --fire evaluation failed: ${err instanceof Error ? err.message : String(err)}`
                )
              );
          }
        : undefined;

      const liveDebuggee = new RdpDebuggee(session, {
        ...(onFirstContinue ? { onFirstContinue } : {}),
        logger,
      });
      debuggee = liveDebuggee;
      opts.onSession?.(session, () => liveDebuggee.triggerInterrupt());

      // Force a genuine RDP all-stop and snapshot before the component starts.
      // The component's startup update_on_stop reads the stop state once; priming
      // here means it captures a real pause with real frames instead of a
      // synthetic "stopped" with no pause behind it (issue #21).
      if (session.hasThreads()) await liveDebuggee.primeStop();

      // The component presents an already-attached, stopped process on connect,
      // which works for `process connect` but breaks LLDB's `process attach`
      // (its ClearAllLoadedSections wipes the connect-time module relocation).
      // So the component listens on a private port and an RSP shim fronts the
      // public `port`, emulating an unattached server until `vAttach` (see
      // attach-shim.ts). LLDB then drives the native attach handshake and
      // `process attach --plugin wasm` works.
      // Use port 0 so the OS assigns the component port — avoids the
      // TOCTOU race that freePort() has (grab-port → close → bind).
      gdbServer = startGdbServer({
        dispatch: (req: unknown) => liveDebuggee.dispatch(req as never),
        port: 0,
        onInfo: (m: string) => logger.debug(`[component] ${m}`),
        onTrace: (m: string) => logger.debug(`[gdbstub] ${boundedTrace(m)}`),
        onError: (m: string) => logger.error(m),
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
        stop: (() => {
          let stopPromise: Promise<void> | undefined;
          return () =>
            (stopPromise ??= (async () => {
              const errors: unknown[] = [];
              try {
                await shim.close();
              } catch (err) {
                errors.push(err);
              }
              try {
                await gdbServer.stop();
              } catch (err) {
                errors.push(err);
              }
              debuggee?.dispose();
              session.close();
              if (errors.length) throw new AggregateError(errors, "failed to stop per-tab server");
            })());
        })(),
      };
    } catch (err) {
      await gdbServer
        ?.stop()
        .catch((stopErr: unknown) =>
          logger.error(
            `failed to stop GDB worker after launch error: ${
              stopErr instanceof Error ? stopErr.message : String(stopErr)
            }`
          )
        );
      debuggee?.dispose();
      session.close();
      throw err;
    }
  };
}

// Bring up Firefox (if launching), the per-tab GDB server launcher, and the
// platform RSP server. Returns once the server is listening. Used by both the
// standalone CLI and the in-process wasm embedding.
export async function startPlatformServer(
  args: Args,
  opts: StartOptions = {}
): Promise<PlatformServerHandle> {
  const verbose = args.verbose || debugEnvEnabled();
  const logger = opts.logger ?? consoleLogger(verbose);
  const launching = !args.connect;

  let firefox: FirefoxHandle | undefined;
  if (launching) {
    firefox = await launchFirefox({
      rdpPort: args.rdpPort,
      binary: args.firefox,
      channel: args.channel,
      defaultProfile: args.defaultProfile,
      headless: args.headless,
      marionettePort: args.marionettePort,
      // NOTE: deliberately not passing url here. Firefox starts on about:blank;
      // the tab is navigated to the page lazily on the first qLaunchGDBServer
      // (see the launcher below). Launching Firefox directly at the page would
      // make that navigate a redundant reload of an already-loaded tab.
    });
    try {
      // The launch-time port check in launchFirefox is best-effort (a stale
      // Firefox could grab the port between that check and this one binding
      // it). Confirm the RDP port actually answers as the instance we just
      // spawned before trusting anything it reports (issue: a leftover
      // Firefox from a previous run can otherwise silently intercept the
      // whole session).
      await verifyFirefoxLaunchToken(args.rdpPort, "127.0.0.1", firefox.launchToken);
    } catch (err) {
      await firefox
        .close()
        .catch((closeErr) =>
          logger.error(
            `failed to clean up Firefox after verification error: ${
              closeErr instanceof Error ? closeErr.message : String(closeErr)
            }`
          )
        );
      throw err;
    }
    logger.info("launched Firefox");
  }

  // currentTabs is updated by the watcher below and read by the platform server
  // to satisfy `platform process list` and resolve `process attach --pid N`.
  let currentTabs: TabInfo[] = [];

  const launcher = createTabLauncher(args, opts, logger, launching, verbose, () => currentTabs);

  const spawner = new GdbServerSpawner(launcher);
  const platformServer = new PlatformServer({
    spawner,
    defaultUrl: args.url,
    listTabs: async () => currentTabs,
    wrapConnectPort: opts.wrapConnectPort,
  });
  const server = new RspServer(platformServer, { logger, singleConnection: true });

  let bound: number;
  try {
    bound = await server.listen(args.port);
  } catch (err) {
    // Firefox is detached from this process, so process exit will not clean it
    // up if a later startup step (most commonly the platform port bind) fails.
    await spawner
      .killAll()
      .catch((stopErr) =>
        logger.error(
          `failed to roll back GDB servers after startup error: ${
            stopErr instanceof Error ? stopErr.message : String(stopErr)
          }`
        )
      );
    await firefox
      ?.close()
      .catch((closeErr) =>
        logger.error(
          `failed to roll back Firefox after startup error: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
        )
      );
    throw err;
  }

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

  const watcherAbort = new AbortController();
  const hinted = new Set<string>();
  const watcherPromise = watchTabs(
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
    logger,
    watcherAbort.signal
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      watcherAbort.abort();
      const errors: unknown[] = [];
      const clean = async (work: Promise<unknown>) => {
        try {
          await work;
        } catch (err) {
          errors.push(err);
        }
      };
      // Stop accepting work first, then tear down per-tab workers/RDP sessions,
      // then the tab watcher, and only then kill Firefox.
      await clean(server.close());
      await clean(spawner.killAll());
      await clean(watcherPromise);
      await clean(firefox?.close() ?? Promise.resolve());
      if (errors.length) throw new AggregateError(errors, "platform shutdown failed");
    })());

  return {
    port: bound,
    platformServer,
    spawner,
    shutdown,
    firefoxExited: firefox?.exited,
    firefoxPid: firefox?.pid,
  };
}
