// Convenience wrapper: launch firefox-lldb-server, wait for it to be ready,
// then exec lldb pre-configured to connect to it.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `\
Usage: firefox-lldb [--lldb <path>] [-h] [server options...]

  --lldb <path>   lldb binary to use (default: $LLDB or "lldb" on PATH).
  -h, --help      Show this message.

All other flags are forwarded to firefox-lldb-server. Run:
  firefox-lldb-server --help
for the full server option list.
`;

interface Args {
  lldb: string;
  url?: string;
  serverArgv: string[];
}

function parseCliArgs(argv: string[]): Args {
  const { values, tokens } = parseArgs({
    args: argv,
    strict: false,
    tokens: true,
    options: {
      lldb: { type: "string" },
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Rebuild serverArgv from all tokens that are not --lldb (consumed locally).
  const serverArgv: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === "option" && tok.name === "lldb") continue;
    if (tok.kind === "option-terminator") continue;
    if (tok.kind === "option") {
      serverArgv.push(`--${tok.name}`);
      if (typeof tok.value === "string") serverArgv.push(tok.value);
    } else if (tok.kind === "positional") {
      serverArgv.push(tok.value);
    }
  }

  return {
    lldb: (values.lldb as string | undefined) ?? process.env.LLDB ?? "lldb",
    url: values.url as string | undefined,
    serverArgv,
  };
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
  const args = parseCliArgs(process.argv.slice(2));

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
