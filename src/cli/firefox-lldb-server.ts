/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// LLDB platform server backed by Firefox over RDP.

import { parseArgs } from "node:util";
import { RspServer, type RspLogger } from "../protocol/rsp-server.js";
import { GdbServerSpawner, type GdbServerLauncher } from "../platform/gdb-server-spawner.js";
import { PlatformServer } from "../platform/platform-server.js";
import { RdpWasmSession, listFirefoxTabs, watchFirefoxTabs, type TabInfo } from "../rdp/session.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import { launchFirefox, type FirefoxHandle } from "../rdp/firefox.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";
import { consoleLogger } from "./logger.js";

const USAGE = `\
Usage: firefox-lldb-server [options]

Modes (default: --launch):
  --launch            Launch a fresh headless Firefox with a throwaway profile.
  --connect           Connect to an already-running Firefox.

Options:
  -p, --port <N>      Platform server RSP port (default: 1234).
  --rdp-port <N>      Firefox RDP port (default: 6080).
  --url <U>           Starting URL (navigated to when LLDB spawns a process;
                      also loaded at startup in --launch mode).
  --firefox <path>    Firefox binary override.
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

interface Args {
  connect: boolean;
  headless: boolean;
  port: number;
  rdpPort: number;
  url?: string;
  firefox?: string;
  fire?: string;
  verbose: boolean;
}

function parseCliArgs(argv: string[]): Args {
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

async function watchTabs(
  rdpPort: number,
  onTabs: (tabs: TabInfo[]) => void,
): Promise<void> {
  for (;;) {
    try {
      await watchFirefoxTabs(rdpPort, "127.0.0.1", onTabs);
      break; // connection closed cleanly
    } catch {
      await sleep(250);
    }
  }
}

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
  throw new Error(`could not connect to Firefox RDP on ${rdpPort}: ${lastErr}`);
}

async function waitForWasm(session: RdpWasmSession): Promise<void> {
  let wasm = (await session.wasmSources())[0];
  for (let i = 0; i < 80 && !wasm; i++) {
    await sleep(100);
    wasm = (await session.wasmSources())[0];
  }
  if (!wasm) throw new Error("no wasm source appeared");
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const logger = consoleLogger(args.verbose || process.env.DEBUG === "1");
  const launching = !args.connect;

  let firefox: FirefoxHandle | undefined;
  if (launching) {
    firefox = await launchFirefox({
      rdpPort: args.rdpPort,
      binary: args.firefox,
      headless: args.headless,
      url: args.url,
    });
    logger.info("launched Firefox");
  }

  const launcher: GdbServerLauncher = async ({ port, url, tabActor }) => {
    // tabActor comes from the watcher connection (conn0). Actor IDs are
    // connection-scoped, so translate to a valid actor on the new session
    // connection by matching position in currentTabs.
    let resolvedActor = tabActor;
    if (tabActor) {
      const idx = currentTabs.findIndex((t) => t.actor === tabActor);
      if (idx >= 0) {
        try {
          const fresh = await listFirefoxTabs(args.rdpPort);
          resolvedActor = fresh[idx]?.actor ?? tabActor;
        } catch {
          // Fall back to the watcher actor and hope for the best.
        }
      }
    }

    const session = launching
      ? await connectWithRetry(args.rdpPort, resolvedActor)
      : await RdpWasmSession.start(args.rdpPort, "127.0.0.1", resolvedActor);

    if (url && !tabActor) {
      await session.navigate(url);
      logger.debug(`[rdp] on ${session.targetUrl}`);
      await waitForWasm(session);
    } else if (!session.threadActor) {
      // Wait for target-available-form rather than sleeping a fixed amount.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          session.off("target", onTarget);
          reject(new Error("timed out waiting for Firefox thread — is this a wasm page?"));
        }, 5000);
        const onTarget = () => {
          clearTimeout(timer);
          resolve();
        };
        session.once("target", onTarget);
      });
    }

    // For the attach case (tabActor provided, no navigation), the tab may be
    // running. Ensure it is paused so that session.resume() in Debuggee.continue
    // actually resumes from a stopped state and reaches a breakpoint.
    if (tabActor && !url) {
      const isPaused = await session.frames().then(() => true).catch(() => false);
      if (!isPaused) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            session.off("paused", onPause);
            reject(new Error("timed out pausing tab for attach"));
          }, 5000);
          const onPause = () => { clearTimeout(timer); resolve(); };
          session.once("paused", onPause);
          session.interrupt().catch((e) => { clearTimeout(timer); session.off("paused", onPause); reject(e); });
        });
      }
    }

    const fire = args.fire;
    const onFirstContinue = fire
      ? () => {
          const wrapped = `(function poll(){try{${fire}}catch(e){setTimeout(poll,20);}})()`;
          session.evaluate(wrapped).catch(() => {});
        }
      : undefined;

    const debuggee = new RdpDebuggee(session, onFirstContinue ? { onFirstContinue } : undefined);
    const { ready, stop } = startGdbServer({
      dispatch: (req: unknown) => debuggee.dispatch(req as never),
      port,
      onInfo: (m: string) => logger.debug(`[component] ${m}`),
    });
    await ready;
    return {
      stop: () => {
        stop();
        session.close();
      },
    };
  };

  const spawner = new GdbServerSpawner(launcher);

  // currentTabs is updated by the watcher below and read by the platform server
  // on every qfProcessInfo — both use the same actor IDs from one connection.
  let currentTabs: TabInfo[] = [];
  const platformServer = new PlatformServer({
    spawner,
    defaultUrl: args.url,
    listTabs: async () => currentTabs,
  });
  const server = new RspServer(platformServer, { logger });

  const bound = await server.listen(args.port);
  // Stdout is the control channel for the firefox-lldb wrapper; stderr carries logs.
  process.stdout.write(`platform server ready on connect://localhost:${bound}\n`);

  if (!launching) {
    listFirefoxTabs(args.rdpPort).catch(() =>
      logger.warn(`could not reach Firefox RDP on port ${args.rdpPort} — is Firefox running with --start-debugger-server ${args.rdpPort}?`)
    );
  }

  let shutdownCalled = false;
  const shutdown = async () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    await spawner.killAll();
    await server.close();
    await firefox?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", () => {});
  firefox?.exited.then(() => shutdown());

  const hinted = new Set<string>();
  void watchTabs(args.rdpPort, (tabs) => {
    currentTabs = tabs;
    for (const tab of tabs) {
      if (!hinted.has(tab.actor) && tab.url && tab.url !== "about:blank") {
        hinted.add(tab.actor);
        const pid = platformServer.tabPid(tab.actor);
        process.stderr.write(
          `\n[info] tab available: ${tab.url} (pid ${pid})\n[info]   run 'platform process list' in lldb, then 'process attach --pid ${pid}'\n`,
        );
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
