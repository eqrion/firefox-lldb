/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Convenience wrapper: launch firefox-lldb-server, wait for it to be ready,
// then exec lldb pre-configured to connect to it.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
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

// Send qLaunchGDBServer to the platform RSP server and return the spawned
// GDB stub port. Uses the same approach as the e2e test harness so that lldb
// can use `process connect --plugin wasm` instead of `process attach`, which
// goes through ProcessGDBRemote and sends vAttach/attachment-verification
// packets the gdbstub-component does not handle.
function launchGdbStub(platformPort: number): Promise<number> {
  const rspFrame = (s: string) => {
    const cs = [...s].reduce((a, c) => (a + c.charCodeAt(0)) & 0xff, 0);
    return `$${s}#${cs.toString(16).padStart(2, "0")}`;
  };

  return new Promise<number>((resolve, reject) => {
    const sock = new net.Socket();
    let buf = "";
    let noAck = false;

    const send = (payload: string) => sock.write(rspFrame(payload));

    sock.connect(platformPort, "127.0.0.1", () => send("QStartNoAckMode"));
    sock.setEncoding("latin1");
    sock.setTimeout(30_000, () => {
      sock.destroy();
      reject(new Error("timeout waiting for GDB stub port"));
    });

    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        // Strip leading acks.
        while (buf.startsWith("+") || buf.startsWith("-")) buf = buf.slice(1);
        const s = buf.indexOf("$");
        if (s < 0) break;
        const e = buf.indexOf("#", s + 1);
        if (e < 0 || buf.length < e + 3) break;
        const payload = buf.slice(s + 1, e);
        buf = buf.slice(e + 3);

        if (!noAck) sock.write("+"); // ack before processing

        if (payload === "OK" && !noAck) {
          noAck = true;
          send("qLaunchGDBServer:port:0;host:localhost;");
        } else {
          const m = payload.match(/port:(\d+)/);
          sock.destroy();
          if (m) resolve(parseInt(m[1], 10));
          else reject(new Error(`qLaunchGDBServer: ${payload}`));
        }
      }
    });

    sock.on("error", reject);
  });
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

  // Wait for "platform server ready on connect://localhost:<port>", then keep piping.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    let ready = false;
    server.stdout!.setEncoding("utf8");
    server.stdout!.on("data", (chunk: string) => {
      if (!ready) {
        buf += chunk;
        const m = buf.match(/platform server ready on connect:\/\/localhost:(\d+)/);
        if (m) {
          ready = true;
          port = Number(m[1]);
          resolve();
        }
      }
    });
    server.on("exit", (code) => {
      reject(new Error(`server exited with code ${code} before becoming ready`));
    });
  });

  const lldbArgs = [
    "-o",
    "platform select remote-gdb-server",
    "-o",
    `platform connect connect://localhost:${port}`,
  ];

  // When a URL is known, pre-launch the GDB stub now (the launcher will
  // navigate Firefox, wait for wasm, then start the stub). This lets lldb use
  // `process connect --plugin wasm` — the only path the gdbstub-component
  // supports — instead of `process attach`, which goes through ProcessGDBRemote
  // and sends vAttach/attachment-verification packets the component rejects.
  if (args.url) {
    process.stderr.write("[info] waiting for wasm to load...\n");
    try {
      const stubPort = await launchGdbStub(port!);
      lldbArgs.push("-o", `process connect --plugin wasm connect://localhost:${stubPort}`);
    } catch (err) {
      process.stderr.write(`[warn] could not pre-launch GDB stub: ${err}\n`);
      // Fall through — user can attach manually.
    }
  } else {
    lldbArgs.push("-o", "platform process list");
  }

  const lldb = spawn(args.lldb, lldbArgs, { stdio: "inherit" });

  lldb.on("error", (err) => {
    process.stderr.write(`[error] failed to start lldb (${args.lldb}): ${err.message}\n`);
    server.kill();
    process.exit(1);
  });

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

  server.on("exit", () => {
    lldb.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
