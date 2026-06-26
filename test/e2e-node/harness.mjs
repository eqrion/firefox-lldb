/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Node e2e harness: drives the embedded wasm LLDB through its off-worker
// "session" API (structured SB-API queries), the same path the `firefox-lldb`
// command uses. This mirrors the Python harness (test/e2e/harness.py) but with
// no native lldb — everything runs in this Node process.

import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../../src/cli/firefox-lldb-server.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

// Mirrors test/e2e/harness.py FIXTURES.
export const FIXTURES = {
  factorial: {
    pageDir: "test/e2e/fixtures/simple",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  sum_range: {
    pageDir: "test/e2e/fixtures/simple",
    fire: "runSum()",
    breakFunc: "sum_range",
    file: "math.cpp",
  },
  oop: { pageDir: "test/e2e/fixtures/oop", fire: "run()", breakFunc: "area", file: "oop.cpp" },
  parser: {
    pageDir: "test/e2e/fixtures/parser",
    fire: "run()",
    breakFunc: "parse_factor",
    file: "parser.cpp",
  },
  ledger: {
    pageDir: "test/e2e/fixtures/ledger",
    fire: "run()",
    breakFunc: "apply_transaction",
    file: "ledger.cpp",
  },
  types: {
    pageDir: "test/e2e/fixtures/types",
    fire: "run()",
    breakFunc: "stop_here",
    file: "types.cpp",
  },
  heap: {
    pageDir: "test/e2e/fixtures/heap",
    fire: "run()",
    breakFunc: "check_heap",
    file: "heap.cpp",
  },
  trap: {
    pageDir: "test/e2e/fixtures/trap",
    fire: "runDivZero()",
    breakFunc: "divide",
    file: "trap.cpp",
  },
  threaded: {
    pageDir: "test/e2e/fixtures/threaded",
    fire: "runMatmul()",
    breakFunc: "matmul_threaded",
    file: "matmul.cpp",
  },
  mixed_js: {
    pageDir: "test/e2e/fixtures/mixed-js",
    fire: "runApp()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

export function startStaticServer(pageDir) {
  const dir = path.join(REPO, pageDir);
  const server = http.createServer((req, res) => {
    const rel =
      decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    try {
      const body = readFileSync(path.join(dir, rel));
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream",
        // COOP/COEP so the page may use SharedArrayBuffer (threaded fixtures).
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A live debug session against a fixture, driven through the session API.
export class Session {
  #client;
  #handle;
  #staticServer;
  #sockets = new Set();

  constructor(client, handle, staticServer) {
    this.#client = client;
    this.#handle = handle;
    this.#staticServer = staticServer;
  }

  async #bridgeTcp(port) {
    const channelId = await this.#client.createChannel();
    const socket = net.connect(port, "127.0.0.1");
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("data", (d) => void this.#client.channelServerWrite(channelId, new Uint8Array(d)));
    socket.on("error", () => {});
    await this.#client.bridgeChannel(channelId, (data) => void socket.write(Buffer.from(data)));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return channelId;
  }

  // Launch headless Firefox at the fixture, attach via the platform, and return
  // a Session. Mirrors harness.py `_start_platform` + `_attach_via_platform`.
  // `fire` overrides the fixture's default fire expression (used by JS tests
  // that need a second deferred call, e.g. "runFactorial(); setTimeout(...)").
  static async attach(fxName, { headless = true, fire } = {}) {
    const fx = FIXTURES[fxName];
    if (!fx) throw new Error(`unknown fixture: ${fxName}`);
    const staticServer = await startStaticServer(fx.pageDir);
    const url = `http://127.0.0.1:${staticServer.port}/index.html`;

    const client = await LLDBClient.create();
    const session = new Session(client, null, staticServer);

    const rdpPort = await freePort();
    const args = parseCliArgs([
      "--launch",
      ...(headless ? ["--headless"] : []),
      "--port",
      "0",
      "--rdp-port",
      String(rdpPort),
      "--url",
      url,
      "--fire",
      fire ?? fx.fire,
    ]);
    const handle = await startPlatformServer(args, {
      wrapConnectPort: (port) => session.#bridgeTcp(port),
    });
    session.#handle = handle;

    const c0 = await session.#bridgeTcp(handle.port);
    await client.sessionCommand("platform select remote-gdb-server");
    const conn = await client.sessionCommand(`platform connect inprocess://${c0}`);
    if (conn.status >= 6) throw new Error(`platform connect failed: ${conn.error}`);

    // Cold launch + wasm load can exceed the attach timeout; retry like the
    // Python harness.
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await client.sessionCommand("process attach --plugin wasm --pid 1");
      if (res.status < 6) {
        const st = await client.sessionState();
        if (st.reason !== "none" && st.reason !== "exited") return session;
        lastErr = `attach left process in state ${st.reason}`;
      } else {
        lastErr = res.error;
      }
      await sleep(1000);
    }
    await session.shutdown();
    throw new Error(`process attach failed after retries: ${lastErr}`);
  }

  // Start the platform server (no Firefox) and connect the session's platform
  // link. Exercises the off-worker session + transport bridge end-to-end
  // without needing a real wasm tab. Used by the infrastructure smoke test.
  static async platformOnly() {
    const client = await LLDBClient.create();
    const session = new Session(client, null, null);
    const rdpPort = await freePort();
    const args = parseCliArgs(["--connect", "--port", "0", "--rdp-port", String(rdpPort)]);
    const handle = await startPlatformServer(args, {
      wrapConnectPort: (port) => session.#bridgeTcp(port),
    });
    session.#handle = handle;
    const c0 = await session.#bridgeTcp(handle.port);
    await client.sessionCommand("platform select remote-gdb-server");
    const conn = await client.sessionCommand(`platform connect inprocess://${c0}`);
    if (conn.status >= 6) throw new Error(`platform connect failed: ${conn.error}`);
    return session;
  }

  // Attach to a fixture, set a breakpoint on its target function, and continue
  // until stopped there. Mirrors harness.py `_stopped_at_breakpoint`.
  static async stoppedAtBreakpoint(fxName) {
    const session = await Session.attach(fxName);
    const fx = FIXTURES[fxName];
    await session.breakpointByName(fx.breakFunc);
    await session.continue();
    const st = await session.state();
    if (st.reason === "none" || st.reason === "exited") {
      await session.shutdown();
      throw new Error(`did not stop at ${fx.breakFunc}: state ${st.reason}`);
    }
    return session;
  }

  command(cmd) {
    return this.#client.sessionCommand(cmd);
  }
  state() {
    return this.#client.sessionState();
  }
  frames() {
    return this.#client.sessionFrames();
  }
  variable(frameIndex, name) {
    return this.#client.sessionVariable(frameIndex, name);
  }

  breakpointByName(name) {
    return this.command(`breakpoint set -n ${name}`);
  }
  breakpointByLocation(file, line) {
    return this.command(`breakpoint set -f ${file} -l ${line}`);
  }
  continue() {
    return this.command("process continue");
  }
  stepInstruction() {
    return this.command("thread step-inst");
  }
  stepOver() {
    return this.command("thread step-over");
  }
  stepOut() {
    return this.command("thread step-out");
  }

  async topFrame() {
    return (await this.frames())[0];
  }

  // Parse the breakpoint number from a `breakpoint set` command result.
  // Returns null if the output doesn't match the expected format.
  static parseBreakpointId(cmdResult) {
    const match = cmdResult.output.match(/Breakpoint (\d+):/);
    return match ? parseInt(match[1]) : null;
  }

  deleteBreakpoint(id) {
    return this.command(`breakpoint delete ${id}`);
  }

  async shutdown() {
    for (const s of this.#sockets) s.destroy();
    await this.#handle?.shutdown().catch(() => {});
    await this.#client.destroy(); // await full worker teardown before the next attach
    await new Promise((resolve) => this.#staticServer?.server.close(resolve));
  }
}
