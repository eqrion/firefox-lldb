/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Composes the browser, tab inventory, platform listener and per-tab launcher.
// Frontends own this runtime handle and any acquisition still in progress.

import { setTimeout as delay } from "node:timers/promises";
import { RspServer } from "../protocol/rsp-server.js";
import { noopLogger, type Logger } from "../diagnostics/logger.js";
import { createTabLauncher } from "./tab-session.js";
import { GdbServerSpawner } from "../platform/gdb-server-spawner.js";
import { PlatformServer } from "../platform/platform-server.js";
import { RdpWasmSession, type TabInfo } from "../rdp/session.js";
import {
  listFirefoxTabs,
  watchAndPrimeFirefoxTabs,
  verifyFirefoxLaunchToken,
} from "../rdp/browser.js";
import type { DebugFileRegistry } from "../symbols/debug-files.js";
import { launchFirefox, type FirefoxChannel, type FirefoxHandle } from "./firefox.js";
import { isTransientConnectionError } from "../rdp/startup.js";

export interface RuntimeOptions {
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
  /** Generate component/attach traces. Defaults to true for production/test parity. */
  trace?: boolean;
}

async function watchTabs(
  rdpPort: number,
  onTabs: (tabs: TabInfo[]) => void,
  logger: Logger,
  signal: AbortSignal,
  reconnect: boolean
): Promise<void> {
  while (!signal.aborted) {
    try {
      await watchAndPrimeFirefoxTabs(rdpPort, "127.0.0.1", onTabs, logger, signal);
      if (!signal.aborted && !reconnect) throw new Error("Firefox RDP tab watcher disconnected");
    } catch (err) {
      if (signal.aborted) return;
      if (!reconnect || !isTransientConnectionError(err)) throw err;
      logger.debug(
        `[rdp] tab watcher reconnecting after: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Whether the RDP connection closed cleanly or with an error, retry after
    // a short delay so --connect mode recovers when Firefox restarts.
    if (!signal.aborted) await delay(250, undefined, { signal }).catch(() => {});
  }
}

export interface StartOptions {
  /** Cancel acquisition before a handle is returned. Rejection joins rollback. */
  signal?: AbortSignal;
  /** Bridge the per-tab GDB server port (see PlatformServerDeps.wrapConnectPort). */
  wrapConnectPort?: (port: number) => Promise<number>;
  /** Override the logger (the in-process embedding uses a quieter one). */
  logger?: Logger;
  /** Called once per newly-seen tab with a non-blank URL. Defaults to printing
   * a `process attach --plugin wasm --pid N` hint to stderr (for native lldb). */
  onTab?: (tab: TabInfo, pid: number) => void;
  /** Where each module's separate DWARF file is registered, for the file
   * provider to serve to LLDB (see DebugFileRegistry). */
  debugFiles?: DebugFileRegistry;
  /** A rolled-back startup is being retried; retain its diagnostic transcript. */
  onStartupRetry?: () => void;
  /** Called as soon as a per-tab RDP session connects, before initial-target,
   * navigation, and prime-stop setup. Intended for diagnostics; debugger
   * operations should continue to use onSession below. */
  onRdpSession?: (session: RdpWasmSession) => void;
  /** Called with each per-tab RDP session as it is created (the in-process
   * embedding uses this after setup to drive `js` commands and console streaming).
   * The second argument requests a real all-stop; the component resumes its
   * execution wait only once pause collection completes. */
  onSession?: (session: RdpWasmSession, interrupt: () => void) => void;
}

export interface PlatformServerHandle {
  port: number;
  platformServer: PlatformServer;
  spawner: GdbServerSpawner;
  shutdown: () => Promise<void>;
  /** First fatal runtime error. The runtime starts shutdown before notifying clients. */
  failed: Promise<Error>;
  /** PID of the launched Firefox (undefined in --connect mode). */
  firefoxPid?: number;
}

// Bring up Firefox (if launching), the per-tab GDB server launcher, and the
// platform RSP server. Returns once the server is listening. Used by both the
// standalone CLI and the in-process wasm embedding.
export async function startPlatformServer(
  args: RuntimeOptions,
  opts: StartOptions = {}
): Promise<PlatformServerHandle> {
  opts.signal?.throwIfAborted();
  const debugEnabled = args.trace ?? true;
  const logger = opts.logger ?? noopLogger;
  const launching = !args.connect;
  let resolveFailed!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => {
    resolveFailed = resolve;
  });
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    logger.error(`[runtime] failed: ${failure.stack ?? failure.message}`);
    void shutdown().catch((cleanupError) =>
      logger.error(`[runtime] failure cleanup: ${String(cleanupError)}`)
    );
    resolveFailed(failure);
  };

  // currentTabs is updated by the watcher below and read by the platform server
  // to satisfy `platform process list` and resolve `process attach --pid N`.
  let currentTabs: TabInfo[] = [];

  let platformServer: PlatformServer;
  const launcher = createTabLauncher(
    args,
    opts,
    logger,
    launching,
    debugEnabled,
    // A vAttach PID must name this session's tab, not merely some advertised tab.
    (pid, tabId) => platformServer.tabPid(tabId) === pid,
    fail
  );

  const spawner = new GdbServerSpawner(launcher, logger);
  platformServer = new PlatformServer({
    spawner,
    defaultUrl: args.url,
    listTabs: async () => currentTabs,
    wrapConnectPort: opts.wrapConnectPort,
  });
  const server = new RspServer(platformServer, { logger, singleConnection: true });

  // Reserve the user-facing platform port before starting Firefox. Besides
  // failing faster, this prevents a transient Firefox startup problem from
  // masking the deterministic EADDRINUSE error the caller needs to fix.
  let bound: number;
  let firefox: FirefoxHandle | undefined;
  try {
    bound = await server.listen(args.port);
    logger.debug(`[state] platform.listening {"port":${bound}}`);
    opts.signal?.throwIfAborted();
    if (launching) {
      logger.debug(
        `[state] browser.launch-started ${JSON.stringify({
          binary: args.firefox,
          channel: args.channel,
          headless: args.headless,
          rdpPort: args.rdpPort,
        })}`
      );
      firefox = await launchFirefox({
        rdpPort: args.rdpPort,
        binary: args.firefox,
        channel: args.channel,
        defaultProfile: args.defaultProfile,
        headless: args.headless,
        marionettePort: args.marionettePort,
        logger,
        signal: opts.signal,
        // NOTE: deliberately not passing url here. Firefox starts on about:blank;
        // the tab is navigated to the page lazily on the first qLaunchGDBServer
        // (see the launcher above). Launching Firefox directly at the page would
        // make that navigate a redundant reload of an already-loaded tab.
      });
      opts.signal?.throwIfAborted();

      // The launch-time port check in launchFirefox is best-effort (a stale
      // Firefox could grab the port between that check and this one binding
      // it). Confirm the RDP port actually answers as the instance we just
      // spawned before trusting anything it reports (issue: a leftover
      // Firefox from a previous run can otherwise silently intercept the
      // whole session).
      const runtime = await verifyFirefoxLaunchToken(
        args.rdpPort,
        "127.0.0.1",
        firefox.launchToken,
        undefined,
        opts.signal,
        logger
      );
      logger.debug(
        `[state] browser.rdp-ready ${JSON.stringify({
          pid: firefox.pid,
          version: runtime.version,
          channel: runtime.channel,
          rdpPort: args.rdpPort,
        })}`
      );
      logger.info(
        `launched Firefox ${runtime.version}${runtime.channel ? ` (${runtime.channel})` : ""}`
      );
    }
    opts.signal?.throwIfAborted();
  } catch (err) {
    // Firefox is detached from this process, so every partially completed
    // startup step must be explicitly rolled back.
    const errors = [err];
    for (const close of [() => server.close(), () => spawner.killAll(), () => firefox?.close()]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
        logger.error(`[state] platform.rollback-failed ${String(error)}`);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, "platform startup and rollback failed");
    opts.signal?.throwIfAborted();
    throw err;
  }

  const watcherAbort = new AbortController();
  // The --connect probe owns a socket too, even before a root greeting arrives.
  const probe = launching
    ? Promise.resolve()
    : listFirefoxTabs(args.rdpPort, "127.0.0.1", watcherAbort.signal).then(
        () => {},
        () => {
          if (!watcherAbort.signal.aborted)
            logger.warn(
              `could not reach Firefox RDP on port ${args.rdpPort} — is Firefox running with --start-debugger-server ${args.rdpPort}?`
            );
        }
      );

  // Default hint suits a native lldb client (no `attach` alias defined).
  const onTab =
    opts.onTab ??
    ((tab: TabInfo, pid: number) =>
      process.stderr.write(
        `\n[info] tab available: ${tab.url}\n` +
          `[info]   process attach --plugin wasm --pid ${pid}\n`
      ));

  const hinted = new Set<number>();
  const watcherPromise = watchTabs(
    args.rdpPort,
    (tabs) => {
      currentTabs = tabs;
      platformServer.updateTabs(tabs);
      for (const tab of tabs) {
        if (!hinted.has(tab.id) && tab.url && tab.url !== "about:blank") {
          hinted.add(tab.id);
          onTab(tab, platformServer.tabPid(tab.id));
        }
      }
    },
    logger,
    watcherAbort.signal,
    args.connect
  ).catch(fail);

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
      await clean(probe);
      await clean(watcherPromise);
      await clean(firefox?.close() ?? Promise.resolve());
      if (errors.length) throw new AggregateError(errors, "platform shutdown failed");
    })());

  return {
    port: bound,
    platformServer,
    spawner,
    shutdown,
    failed,
    firefoxPid: firefox?.pid,
  };
}
