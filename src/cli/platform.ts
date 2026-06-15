// Entry point for the LLDB platform server (M1).
//
// Usage: tsx src/cli/platform.ts [--port N] [--verbose]
//
// Connect from LLDB with:
//   (lldb) platform select remote-gdb-server
//   (lldb) platform connect connect://localhost:<port>

import { RspServer, type RspHandler } from "../protocol/rsp-server.js";
import { LocalFileSystem } from "../platform/filesystem.js";
import { GdbServerSpawner } from "../platform/gdb-server-spawner.js";
import { DefaultProcessProvider } from "../platform/process-provider.js";
import { PlatformServer } from "../platform/platform-server.js";
import { consoleLogger } from "./logger.js";

// Placeholder GDB-server handler until the wasm GDB server (M2) is wired in.
// It answers the handshake minimally so a probing client does not hang.
function placeholderGdbHandler(): RspHandler {
  return {
    async handle(payload, session) {
      const data = payload.toString("latin1");
      if (data === "QStartNoAckMode") {
        session.setNoAckMode(true);
        return "OK";
      }
      if (data.startsWith("qSupported")) return "PacketSize=4096";
      return "";
    },
  };
}

function parseArgs(argv: string[]): { port: number; verbose: boolean } {
  let port = 1234;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") port = parseInt(argv[++i], 10);
    else if (argv[i] === "--verbose" || argv[i] === "-v") verbose = true;
  }
  return { port, verbose };
}

async function main(): Promise<void> {
  const { port, verbose } = parseArgs(process.argv.slice(2));
  const logger = consoleLogger(verbose || process.env.DEBUG === "1");

  const fs = new LocalFileSystem();
  const spawner = new GdbServerSpawner(placeholderGdbHandler, logger);
  const processes = new DefaultProcessProvider();

  const server = new RspServer(
    () => new PlatformServer({ fs, spawner, processes }),
    { logger }
  );

  const bound = await server.listen(port);
  logger.info(`platform server ready on connect://localhost:${bound}`);

  const shutdown = async () => {
    await spawner.killAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
