#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Convenience wrapper: run the platform server in-process and drive an embedded
// LLDB (compiled to WebAssembly) behind a language-generic (sdb) prompt on this
// terminal. No native lldb binary is required.
//
// The wasm LLDB cannot open TCP sockets, so its RSP connections (the platform
// connection and each per-tab GDB server) are bridged to the in-process TCP
// servers through in-memory channels: LLDB connects to "inprocess://<id>" and
// we pump bytes between channel <id> and a localhost socket.

import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { parseCliArgs, startPlatformServer } from "../core/platform-session.js";
import { focusFirefoxWindow } from "../rdp/firefox.js";
import { quietLogger } from "./logger.js";
import { runRepl } from "./repl.js";
import type { RdpWasmSession } from "../rdp/session.js";
import { debugEnvEnabled } from "../config.js";
import { EmbeddedLldbComponentRuntime } from "../source-debugger/lldb-runtime.js";
import { SourceDebuggerSession } from "../source-debugger/session.js";
import { componentForModuleUrl, parseComponentRoutes } from "../source-debugger/config.js";
import {
  connectSourceDebuggerComponent,
  serveSourceDebuggerComponent,
  type SourceDebuggerRpcEndpoint,
} from "../source-debugger/rpc.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();
  const logger = quietLogger(verbose);
  const routes = parseComponentRoutes(args.components);
  const routedComponents = args.components.length > 0;
  if (routes.length > 1 && !args.url) {
    throw new Error("multiple --component routes currently require --url for automatic attach");
  }

  const runtimes: EmbeddedLldbComponentRuntime[] = [];
  try {
    for (const route of routes) {
      runtimes.push(
        await EmbeddedLldbComponentRuntime.create({
          id: route.id,
          name: routes.length === 1 && route.id === "lldb" ? "LLDB" : `LLDB (${route.id})`,
          logger,
          fileProvider: (path) => readFile(path).catch(() => null),
          observerResumesTarget: routes.length === 1,
          exclusiveModules: routedComponents,
        })
      );
    }
  } catch (error) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    throw error;
  }
  const componentEndpoints: SourceDebuggerRpcEndpoint[] = [];
  const components = await Promise.all(
    runtimes.map(async ({ component }) => {
      const { port1, port2 } = new MessageChannel();
      const endpoint = serveSourceDebuggerComponent(port1, component);
      componentEndpoints.push(endpoint);
      try {
        return await connectSourceDebuggerComponent(port2);
      } catch (error) {
        endpoint.close();
        throw error;
      }
    })
  ).catch(async (error) => {
    for (const endpoint of componentEndpoints) endpoint.close();
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    throw error;
  });
  let session: RdpWasmSession | undefined;
  const sourceDebuggerSession = new SourceDebuggerSession({
    components,
    getRdpSession: () => session,
    selectModuleOwner: (module) => componentForModuleUrl(routes, module.url).id,
    logger,
  });

  const handles: Awaited<ReturnType<typeof startPlatformServer>>[] = [];
  let exiting = false;
  const cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    const work = [
      () => sourceDebuggerSession.close(),
      ...componentEndpoints.map((endpoint) => () => endpoint.close()),
      ...[...handles].reverse().map((handle) => () => handle.shutdown()),
      ...runtimes.map((runtime) => () => runtime.close()),
    ];
    for (const run of work) {
      try {
        await run();
      } catch (err) {
        logger.error(`[cleanup] ${err instanceof Error ? err.message : String(err)}`);
        code = code || 1;
      }
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => void cleanup(0));
  process.on("SIGHUP", () => void cleanup(0));

  // A dead parent (e.g. a pty master closing, or a controlling process being
  // killed) doesn't always deliver a signal. Poll for reparenting to
  // init/launchd (ppid 1) and clean up when it happens.
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) void cleanup(0);
  }, 1000);
  orphanCheck.unref();

  // The REPL owns the terminal; `js` commands and console streaming need the
  // live RDP session, which the platform server hands us via onSession.
  let triggerInterrupt: (() => void) | undefined;
  const repl = runRepl({
    session: sourceDebuggerSession,
    onExit: () => void cleanup(0),
    onTargetResume: () => {
      if (handles[0]?.firefoxPid !== undefined) focusFirefoxWindow(handles[0].firefoxPid);
    },
    onTargetInterrupt: () => triggerInterrupt?.(),
  });

  // Each per-tab GDB server launched by qLaunchGDBServer gets bridged; the
  // platform server returns the channel ID as the connection "port" and the
  // wasm LLDB connects to inprocess://<id> (PlatformWasmRemoteGDBServer::MakeUrl).
  try {
    const primary = runtimes[0];
    const primaryRoute = routes[0];
    const handle = await startPlatformServer(args, {
      wrapConnectPort: primary.bridgeTcp,
      runControl: primary.runControl,
      ...(routedComponents
        ? {
            moduleFilter: (url: string, kind: "wasm" | "javascript") =>
              kind === "wasm" && componentForModuleUrl(routes, url).id === primaryRoute.id,
          }
        : {}),
      logger,
      onTab: (tab, pid) => repl.print(`tab available: ${tab.url}\n  attach --pid ${pid}`),
      onSession: (s, interrupt) => {
        session = s;
        triggerInterrupt = interrupt;
        void s.streamConsole((m) => repl.printConsole(m));
        // "navigated" fires as soon as the old top-level target is gone, before
        // the new one (if any) arrives — too early to know the destination URL.
        // Wait for the next top-level "target" to report where the page landed;
        // if none ever arrives, "detached" below reports the tab closed instead.
        let awaitingNavigationTarget = false;
        s.on("navigated", () => {
          repl.print("page navigating; re-syncing debug session...");
          awaitingNavigationTarget = true;
        });
        s.on("target", (info) => {
          if (!info.isTopLevel || !awaitingNavigationTarget) return;
          awaitingNavigationTarget = false;
          repl.print(`page navigated to ${info.url}`);
        });
        s.on("detached", () => {
          repl.print("the attached tab was closed; detaching.");
          session = undefined;
          triggerInterrupt = undefined;
          for (const runtime of runtimes) {
            void runtime
              .command("process detach")
              .catch((err) => logger.debug(`[cleanup] LLDB detach failed: ${String(err)}`));
          }
        });
      },
    });
    handles.push(handle);

    // Quit when a launched Firefox goes away (#24).
    void handle.firefoxExited?.then(() => {
      repl.print("Firefox exited.");
      void cleanup(0);
    });

    // Bridge the platform connection itself, then drive the platform setup the
    // native wrapper used to pass via `-o`. These produce noisy connect chatter,
    // so we run them quietly and only surface the attach / tab list.
    await primary.connectPlatform(handle.port);
    await primary.command("command alias attach process attach --plugin wasm");

    let intro =
      "firefox-lldb source debugger — `attach --pid N` to attach, `help` for generic commands.";
    if (args.url) {
      repl.print(intro + "\nattaching...");
      intro = await primary.attach(1, {
        onRetry: (attempt) =>
          repl.print(`automatic attach attempt ${attempt} was interrupted; retrying...`),
      });

      if (runtimes.length > 1 && !session) {
        throw new Error("primary component attached without publishing its RDP session");
      }
      for (let index = 1; index < runtimes.length; index++) {
        const runtime = runtimes[index];
        const route = routes[index];
        repl.print(`attaching ${route.id}...`);
        const secondaryHandle = await startPlatformServer(
          {
            ...args,
            connect: true,
            port: 0,
            url: undefined,
            fire: undefined,
          },
          {
            wrapConnectPort: runtime.bridgeTcp,
            sharedRdpSession: session,
            runControl: runtime.runControl,
            moduleFilter: (url, kind) =>
              kind === "wasm" && componentForModuleUrl(routes, url).id === route.id,
            logger,
          }
        );
        handles.push(secondaryHandle);
        await runtime.connectPlatform(secondaryHandle.port);
        await runtime.command("command alias attach process attach --plugin wasm");
        // Let the connect-mode tab watcher populate its stable PID map before
        // the attach handshake asks it to launch the per-tab RSP server.
        await new Promise((resolve) => setTimeout(resolve, 250));
        await runtime.command("platform process list");
        await runtime.attach(1, {
          onRetry: (attempt) =>
            repl.print(`${route.id} attach attempt ${attempt} was interrupted; retrying...`),
        });
      }
    } else {
      const res = await primary.command("platform process list");
      intro += "\n" + res.output.trimEnd();
    }
    repl.start(intro);
  } catch (err) {
    logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    await cleanup(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
