#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Load the configured SourceDebuggerComponents, activate them against Firefox,
// and present their language-generic SourceDebuggerSession through the (sdb)
// prompt. Engine-specific target bootstrap lives inside the installed loaders.

import { parseCliArgs } from "../core/platform-session.js";
import { quietLogger } from "./logger.js";
import { runRepl } from "./repl.js";
import { debugEnvEnabled, sourceDebuggerTraceEnabled } from "../config.js";
import {
  LldbSourceDebuggerComponentLoader,
  LldbSourceDebuggerTarget,
} from "../source-debugger/lldb-loader.js";
import { SourceDebuggerSessionRuntime } from "../source-debugger/runtime.js";
import {
  createRoutedModuleOwnerResolver,
  parseComponentRoutes,
} from "../source-debugger/config.js";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const verbose = args.verbose || debugEnvEnabled();
  const sourceTrace = sourceDebuggerTraceEnabled();
  const logger = quietLogger(verbose);
  const sourceLogger = verbose ? logger : quietLogger(sourceTrace);
  const routes = parseComponentRoutes(args.components);
  const routedComponents = args.components.length > 0;
  if (routes.length > 1 && !args.url) {
    throw new Error("multiple --component routes currently require --url for automatic attach");
  }

  let repl: ReturnType<typeof runRepl> | undefined;
  let cleanup: (code?: number) => Promise<void> = async () => {};
  const target = new LldbSourceDebuggerTarget({
    args,
    routes,
    logger,
    onOutput: (message) => repl?.print(message),
    onConsole: (message) => repl?.printConsole(message),
    onFirefoxExit: () => {
      repl?.print("Firefox exited.");
      void cleanup(0);
    },
  });
  const loaders = routes.map(
    (route) =>
      new LldbSourceDebuggerComponentLoader(target, route, {
        name: routes.length === 1 && route.id === "lldb" ? "LLDB" : `LLDB (${route.id})`,
        logger: sourceLogger,
        observerResumesTarget: routes.length === 1,
        exclusiveModules: routedComponents,
        verbose: verbose || sourceTrace,
      })
  );
  const runtime = await SourceDebuggerSessionRuntime.load({
    loaders,
    getRdpSession: () => target.rdpSession,
    createModuleOwnerResolver: (components) => createRoutedModuleOwnerResolver(routes, components),
    logger: sourceLogger,
  });

  let exiting = false;
  cleanup = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    try {
      await runtime.close();
    } catch (err) {
      logger.error(`[cleanup] ${err instanceof Error ? err.message : String(err)}`);
      code = code || 1;
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

  repl = runRepl({
    session: runtime.session,
    onExit: () => void cleanup(0),
    onTargetResume: () => target.focus(),
    onTargetInterrupt: () => target.interrupt(),
  });

  try {
    const activation = await runtime.activate();
    repl.start(activation.readyMessage);
  } catch (err) {
    logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    await cleanup(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
