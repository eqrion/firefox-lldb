/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// LLDB platform server backed by Firefox over RDP.

import { parseArgs } from "node:util";
import { RspServer } from "../protocol/rsp-server.js";
import { GdbServerSpawner, type GdbServerLauncher } from "../platform/gdb-server-spawner.js";
import { PlatformServer } from "../platform/platform-server.js";
import { RdpWasmSession, listFirefoxTabs, watchFirefoxTabs, type TabInfo } from "../rdp/session.js";
import { setRdpTrace } from "../rdp/transport.js";
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

async function watchTabs(rdpPort: number, onTabs: (tabs: TabInfo[]) => void): Promise<void> {
  for (;;) {
    try {
      await watchFirefoxTabs(rdpPort, "127.0.0.1", onTabs);
      break;
    } catch {
      await sleep(250);
    }
  }
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
  const verbose = args.verbose || process.env.DEBUG === "1";
  const logger = consoleLogger(verbose);
  setRdpTrace(verbose);
  const launching = !args.connect;

  let firefox: FirefoxHandle | undefined;
  if (launching) {
    firefox = await launchFirefox({
      rdpPort: args.rdpPort,
      binary: args.firefox,
      headless: args.headless,
      // Open the page at startup (issue #4). Otherwise Firefox sits on
      // about:blank until the first attach, which shows the wrong name in
      // `platform process list` and — headless — cannot even be listed over RDP
      // (a blank tab has no window global), breaking `process attach --pid N`.
      url: args.url,
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

    // Close the session on any failure past this point; otherwise a launch that
    // throws (e.g. waitForWasm times out) leaks the RDP watcher connection, and
    // a retried qLaunchGDBServer accumulates dead sessions against Firefox.
    try {
      // Connect supplies an explicit url and always navigates (unchanged). Attach
      // (tabActor set, no url) navigates to the configured --url only if the tab
      // has not yet loaded a wasm page, so `process attach` works against a
      // freshly launched Firefox; an already-loaded tab keeps its content.
      const navTo = url ?? ((await session.wasmSources()).length ? undefined : args.url);
      if (navTo) {
        await session.navigate(navTo);
        logger.debug(`[rdp] navigated to ${navTo}`);
        await waitForWasm(session);
      } else if (!session.hasThreads()) {
        await sleep(500);
      } else {
        // For the attach case, ensure all threads are paused so that
        // resumeAll() in Debuggee.continue works from a stopped state.
        const tids = session.listTids();
        const isRunning = await session
          .frames(tids[0])
          .then(() => false)
          .catch(() => true);
        if (isRunning) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              session.off("stopped", onStopped);
              reject(new Error("timed out pausing threads for attach"));
            }, 5000);
            const onStopped = () => {
              clearTimeout(timer);
              resolve();
            };
            session.once("stopped", onStopped);
            session.armAllStop();
            session.interrupt(tids[0]);
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
        verbose,
      });
      await ready;
      return {
        stop: () => {
          stop();
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
  });
  const server = new RspServer(platformServer, { logger });

  const bound = await server.listen(args.port);
  // Stdout is the control channel for the firefox-lldb wrapper; stderr carries logs.
  process.stdout.write(`platform server ready on connect://localhost:${bound}\n`);

  if (!launching) {
    listFirefoxTabs(args.rdpPort).catch(() =>
      logger.warn(
        `could not reach Firefox RDP on port ${args.rdpPort} — is Firefox running with --start-debugger-server ${args.rdpPort}?`
      )
    );
  }

  const hinted = new Set<string>();
  void watchTabs(args.rdpPort, (tabs) => {
    currentTabs = tabs;
    for (const tab of tabs) {
      if (!hinted.has(tab.actor) && tab.url && tab.url !== "about:blank") {
        hinted.add(tab.actor);
        const pid = platformServer.tabPid(tab.actor);
        process.stderr.write(
          `\n[info] tab available: ${tab.url}\n` +
            `[info]   process attach --plugin wasm --pid ${pid}\n`
        );
      }
    }
  });

  const shutdown = async () => {
    await spawner.killAll();
    await server.close();
    await firefox?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", () => {});

  // When launched session-detached (e.g. the e2e harness uses setsid), a killed
  // parent does not signal us, so we would orphan the launched Firefox. Poll for
  // reparenting to init/launchd (ppid 1) and shut down cleanly when it happens.
  if (process.env.FIREFOX_LLDB_EXIT_WHEN_ORPHANED) {
    const timer = setInterval(() => {
      if (process.ppid === 1) {
        logger.warn("parent process exited; shutting down to release Firefox");
        void shutdown();
      }
    }, 1000);
    timer.unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
