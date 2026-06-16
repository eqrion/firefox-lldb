// Unified entry point for the firefox-lldb bridge.
//
// Starts an LLDB platform server backed by Firefox over RDP. LLDB attaches
// with:
//   (lldb) platform select remote-gdb-server
//   (lldb) platform connect connect://localhost:<port>
//   (lldb) platform process launch -- <url>
//
// Modes:
//   --launch  (default) Launch a fresh headless Firefox with a throwaway profile.
//   --connect           Connect to an already-running Firefox.
//
// Flags:
//   --port <N>          Platform server RSP port (default 1234).
//   --rdp-port <N>      Firefox RDP port (default 6080).
//   --url <U>           Starting URL (navigated to when LLDB spawns a process;
//                       also loaded at startup in --launch mode for quick use).
//   --firefox <path>    Firefox binary override.
//   --headless          Run Firefox headlessly (default off; on for tests).
//   --fire <js>         Evaluate JS after the first breakpoint arms (test use).
//   --verbose / -v      Log debug output.

import { RspServer } from "../protocol/rsp-server.js";
import { GdbServerSpawner, type GdbServerLauncher } from "../platform/gdb-server-spawner.js";
import { PlatformServer } from "../platform/platform-server.js";
import { RdpWasmSession } from "../rdp/session.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import { launchFirefox, type FirefoxHandle } from "../rdp/firefox.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";
import { consoleLogger } from "./logger.js";

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

function parseArgs(argv: string[]): Args {
  const a: Args = {
    connect: false,
    headless: false,
    port: 1234,
    rdpPort: 6080,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--connect") a.connect = true;
    else if (v === "--launch") a.connect = false;
    else if (v === "--headless") a.headless = true;
    else if (v === "--port" || v === "-p") a.port = Number(argv[++i]);
    else if (v === "--rdp-port") a.rdpPort = Number(argv[++i]);
    else if (v === "--url") a.url = argv[++i];
    else if (v === "--firefox") a.firefox = argv[++i];
    else if (v === "--fire") a.fire = argv[++i];
    else if (v === "--verbose" || v === "-v") a.verbose = true;
  }
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(rdpPort: number): Promise<RdpWasmSession> {
  let lastErr: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      return await RdpWasmSession.start(rdpPort);
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
  const args = parseArgs(process.argv.slice(2));
  const logger = consoleLogger(args.verbose || process.env.DEBUG === "1");
  const launching = !args.connect;

  let firefox: FirefoxHandle | undefined;
  if (launching) {
    firefox = await launchFirefox({
      rdpPort: args.rdpPort,
      binary: args.firefox,
      headless: args.headless,
    });
    logger.info("launched Firefox");
  }

  const launcher: GdbServerLauncher = async ({ port, url }) => {
    const session = launching
      ? await connectWithRetry(args.rdpPort)
      : await RdpWasmSession.start(args.rdpPort);

    if (url) {
      await session.navigate(url);
      logger.debug(`[rdp] on ${session.targetUrl}`);
      await waitForWasm(session);
    } else if (!session.threadActor) {
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
  const server = new RspServer(new PlatformServer({ spawner, defaultUrl: args.url }), { logger });

  const bound = await server.listen(args.port);
  logger.info(`platform server ready on connect://localhost:${bound}`);

  const shutdown = async () => {
    await spawner.killAll();
    await server.close();
    await firefox?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
