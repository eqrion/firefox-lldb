// Entry point for the wasm debugging bridge.
//
// Connects to a running Firefox over RDP, enables wasm debugging (observeWasm)
// on the selected tab, optionally navigates to a page, and serves the gdbstub
// component on a TCP port. An LLDB client then attaches with:
//   (lldb) process connect --plugin wasm connect://127.0.0.1:<port>
//
// Requires Node >=24 with --experimental-wasm-jspi (the gdbstub component runs
// on a worker and uses JSPI for jco's resource glue).

import { RdpWasmSession } from "../rdp/session.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";

interface Args {
  rdpPort: number;
  port: number;
  page?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { rdpPort: 6080, port: 8123, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--rdp-port") a.rdpPort = Number(argv[++i]);
    else if (v === "--port" || v === "-p") a.port = Number(argv[++i]);
    else if (v === "--page") a.page = argv[++i];
    else if (v === "--verbose" || v === "-v") a.verbose = true;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const session = await RdpWasmSession.start(args.rdpPort);
  console.error(`[rdp] connected to Firefox on ${args.rdpPort}`);
  if (args.page) {
    await session.navigate(args.page);
    console.error(`[rdp] navigated to ${session.targetUrl}`);
  } else if (!session.threadActor) {
    // Wait briefly for the initial target.
    await new Promise((r) => setTimeout(r, 500));
  }

  const debuggee = new RdpDebuggee(session);
  const { ready, stop } = startGdbServer({
    dispatch: (req: unknown) => debuggee.dispatch(req as never),
    port: args.port,
    onInfo: (m: string) => console.error(`[component] ${m}`),
    verbose: args.verbose,
  });
  await ready;

  console.error(
    `\nAttach LLDB:\n  (lldb) process connect --plugin wasm connect://127.0.0.1:${args.port}\n`
  );

  const shutdown = () => {
    stop();
    session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
