// Convenience wrapper: launch firefox-lldb-server, wait for it to be ready,
// then exec lldb pre-configured to connect to it.
//
// Usage (dev):
//   node --import tsx src/cli/firefox-lldb.ts [--lldb <path>] [server flags]
//
// Server flags passed through: --port, --rdp-port, --url, --firefox,
//   --headless, --launch (default), --connect, --verbose / -v.
//
// The lldb binary is taken from $LLDB or "lldb" on PATH.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  lldb: string;
  url?: string;
  serverArgv: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    lldb: process.env.LLDB ?? "lldb",
    serverArgv: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--lldb") {
      a.lldb = argv[++i];
    } else if (v === "--url") {
      a.url = argv[i + 1];
      a.serverArgv.push(v, argv[++i]);
    } else {
      a.serverArgv.push(v);
    }
  }
  return a;
}

function resolveServerScript(): string {
  // When packaged (dist/), the server lives alongside this file.
  // In dev (src/cli/), reference the sibling source file.
  const here = __dirname;
  const devScript = path.join(here, "firefox-lldb-server.ts");
  const builtScript = path.join(here, "firefox-lldb-server.js");
  return existsSync(devScript) ? devScript : builtScript;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const serverScript = resolveServerScript();
  const nodeArgs = serverScript.endsWith(".ts")
    ? ["--import", "tsx", serverScript]
    : [serverScript];

  const server = spawn(process.execPath, [...nodeArgs, ...args.serverArgv], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  let port: number | undefined;

  // Wait for "platform server ready on connect://localhost:<port>"
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    server.stdout!.setEncoding("utf8");
    server.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      process.stdout.write(chunk);
      const m = buf.match(/platform server ready on connect:\/\/localhost:(\d+)/);
      if (m) {
        port = Number(m[1]);
        resolve();
      }
    });
    server.on("exit", (code) => {
      reject(new Error(`server exited with code ${code} before becoming ready`));
    });
  });

  // Pipe remaining server stdout to our stdout.
  server.stdout!.on("data", (chunk: string) => process.stdout.write(chunk));

  const lldbArgs = [
    "-o",
    "platform select remote-gdb-server",
    "-o",
    `platform connect connect://localhost:${port}`,
  ];
  if (args.url) {
    lldbArgs.push("-o", `platform process launch -- ${args.url}`);
  }

  const lldb = spawn(args.lldb, lldbArgs, { stdio: "inherit" });

  const cleanup = () => {
    server.kill();
    lldb.kill();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  lldb.on("exit", () => {
    server.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
