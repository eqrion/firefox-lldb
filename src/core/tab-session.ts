/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setTimeout as delay } from "node:timers/promises";
import { LaunchRollbackError, type GdbServerLauncher } from "../platform/gdb-server-spawner.js";
import { startAttachShim } from "../protocol/attach-shim.js";
import { RdpWasmSession, NavigationTargetLostError } from "../rdp/session.js";
import { withRdpStartupRetry } from "../rdp/startup.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import type { Logger } from "../diagnostics/logger.js";
import type { RuntimeOptions, StartOptions } from "./platform-session.js";
import { startGdbServer } from "../gdb/worker/host.mjs";

const MAX_TRACE_CHARS = 4096;
// Leave room in LLDB's attach deadline for one same-tab reacquisition.
const STARTUP_NAVIGATION_TIMEOUT_MS = 5000;

function boundedTrace(message: string): string {
  if (message.length <= MAX_TRACE_CHARS) return message;
  return `${message.slice(0, MAX_TRACE_CHARS)}… [${message.length - MAX_TRACE_CHARS} chars omitted]`;
}

async function connectWithRetry(
  rdpPort: number,
  tabId: number | undefined,
  logger: Logger,
  signal: AbortSignal
): Promise<RdpWasmSession> {
  return withRdpStartupRetry(
    (attemptSignal) =>
      RdpWasmSession.start(rdpPort, "127.0.0.1", tabId, logger, undefined, attemptSignal),
    { signal, logger }
  );
}

// Acquires one tab's RDP session, adapter, component and attach shim.
// Rollback owns partial resources until the returned stop handle takes over.
export function createTabLauncher(
  args: RuntimeOptions,
  opts: StartOptions,
  logger: Logger,
  launching: boolean,
  debugEnabled: boolean,
  isValidAttachPid: (pid: number, tabId: number) => boolean,
  onFailure: (error: Error) => void
): GdbServerLauncher {
  const launch: GdbServerLauncher = async ({ port, url, tabId, signal }) => {
    signal.throwIfAborted();
    const session = launching
      ? await connectWithRetry(args.rdpPort, tabId, logger, signal)
      : await RdpWasmSession.start(args.rdpPort, "127.0.0.1", tabId, logger, undefined, signal);
    let debuggee: RdpDebuggee | undefined;
    let gdbServer: ReturnType<typeof startGdbServer> | undefined;
    let shim: Awaited<ReturnType<typeof startAttachShim>> | undefined;
    let stage = "initial-target";
    let disconnected = false;
    session.once("close", () => {
      disconnected = true;
      if (stage === "ready") onFailure(new Error("per-tab Firefox RDP connection closed"));
    });
    const checkpoint = (next: string) => {
      signal.throwIfAborted();
      if (disconnected) throw new Error(`per-tab Firefox RDP connection closed during ${stage}`);
      stage = next;
      logger.debug(`[launch] stage=${stage} tab=${tabId ?? "selected"}`);
    };
    const abort = () => {
      logger.debug(`[launch] cancel stage=${stage}: ${String(signal.reason)}`);
      // Close the FIFO owner to settle protocol/lifecycle waits. Terminating
      // the worker also releases readiness even if its synchronous RPC stalls.
      session.close();
      void gdbServer
        ?.stop()
        .catch((error: unknown) =>
          logger.error(`[launch] worker cancellation failed: ${String(error)}`)
        );
    };
    signal.addEventListener("abort", abort, { once: true });

    // Rollback and normal disposal share the same resource order. Keep the shim
    // in this scope so a bind that completes after abort is still cleaned up.
    let stopPromise: Promise<void> | undefined;
    const stop = () =>
      (stopPromise ??= (async () => {
        stage = "stopping";
        const errors: unknown[] = [];
        try {
          await shim?.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await gdbServer?.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          debuggee?.dispose();
        } catch (error) {
          errors.push(error);
        }
        session.close();
        if (errors.length) throw new AggregateError(errors, "failed to stop per-tab server");
      })());

    // Close the session on any failure past this point; otherwise a launch that
    // throws leaks the RDP watcher connection, and a retried qLaunchGDBServer
    // accumulates dead sessions against Firefox.
    try {
      checkpoint("initial-target");
      opts.onRdpSession?.(session);
      signal.throwIfAborted();
      // watchTargets can acknowledge the subscription before delivering the
      // initial top-level target. Navigating in that gap makes navigate() see
      // generation 0 and lets the late about:blank event satisfy its
      // "replacement target" wait. Establish the initial generation first.
      await session.waitForTopLevelTarget();
      checkpoint("sources");

      // Navigate to the target page when needed. The watcher connection runs
      // watchAndPrimeFirefoxTabs which sets observeWasm:true on the tab before
      // any page loads; pages navigated after that compile wasm in debug mode
      // automatically. A navigation is only needed when:
      //   - an explicit url came from qLaunchGDBServer (e.g. `process launch`), or
      //   - no wasm is loaded yet and --url is configured (initial page load), or
      //   - wasm IS loaded but has empty breakpoint positions (not in debug mode,
      //     which can happen if it loaded before the priming connection was ready).
      const wasm0 = await session.wasmSources();
      checkpoint("breakpoint-positions");
      const inDebugMode =
        wasm0.length > 0 && (await session.wasmBreakpointOffsets(wasm0[0].actor)).length > 0;
      checkpoint("navigation");
      const tabUrl = session.topLevelUrl();
      const navTo =
        url ??
        (!wasm0.length
          ? args.url
          : !inDebugMode
            ? (args.url ?? (tabUrl && tabUrl !== "about:blank" ? tabUrl : undefined))
            : undefined);
      if (navTo) {
        await session.navigate(navTo, STARTUP_NAVIGATION_TIMEOUT_MS);
        logger.debug(`[rdp] navigated to ${navTo}`);
        // Do not wait for lazy wasm compilation. The adapter discovers modules
        // again at each stop, including modules compiled after attach.
      } else if (!session.hasThreads()) {
        await delay(500, undefined, { signal });
      }
      checkpoint("prime-stop");

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
        ...(opts.debugFiles ? { debugFiles: opts.debugFiles } : {}),
        logger,
      });
      debuggee = liveDebuggee;
      opts.onSession?.(session, () => liveDebuggee.triggerInterrupt());
      signal.throwIfAborted();

      // The component reads stop state at startup; collect a real all-stop
      // snapshot before starting it.
      if (session.hasThreads()) await liveDebuggee.primeStop();
      checkpoint("worker-ready");

      // The shim delays process publication until vAttach so LLDB retains
      // module relocation. Bind the private port atomically with port zero.
      gdbServer = startGdbServer({
        dispatch: (req) => liveDebuggee.dispatch(req),
        port: 0,
        onInfo: (m: string) => logger.debug(`[component] ${m}`),
        onTrace: (m: string) => logger.debug(`[gdbstub] ${boundedTrace(m)}`),
        onError: (m: string) => logger.error(m),
        // Startup failure belongs to launch/rollback; after publication it is
        // a runtime failure even if LLDB is idle and has no request pending.
        onFailure: (error) => {
          if (stage === "ready") onFailure(error);
        },
        verbose: debugEnabled,
      });
      await gdbServer.ready;
      checkpoint("shim-bind");
      shim = await startAttachShim({
        listenPort: port,
        componentPort: gdbServer.port,
        isValidPid: (pid) => isValidAttachPid(pid, session.tabId),
        trace: debugEnabled ? (m) => logger.debug(`[shim] ${m}`) : undefined,
      });
      checkpoint("ready");
      return {
        port: shim.port,
        stop,
      };
    } catch (err) {
      logger.debug(`[launch] failed stage=${stage}: ${String(err)}`);
      session.close();
      try {
        await stop();
      } catch (stopError) {
        logger.error(`[launch] rollback failed stage=${stage}: ${String(stopError)}`);
        throw new LaunchRollbackError(err, stopError);
      }
      signal.throwIfAborted();
      throw err;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  return async (request) => {
    try {
      return await launch(request);
    } catch (error) {
      // Only an unpublished, fully rolled-back navigation may reacquire once.
      // Resolve the same browserId on the new connection, never the selected tab.
      if (!(error instanceof NavigationTargetLostError)) throw error;
      request.signal.throwIfAborted();
      opts.onStartupRetry?.();
      logger.warn(`[launch] reacquiring lost startup target tab=${error.tabId}: ${error.message}`);
      return launch({ ...request, tabId: error.tabId });
    }
  };
}
