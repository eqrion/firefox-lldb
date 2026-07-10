/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// REPL-level e2e harness: boots the same Firefox + platform-server + bridge
// stack as harness.mjs, then drives the *real* runRepl (src/cli/repl.ts) with
// injected streams. This exercises the dominant `firefox-lldb` code path —
// readline routing, js subcommands, console streaming — rather than the
// lower-level session API the Session harness drives directly.

import net from "node:net";
import { PassThrough, Writable } from "node:stream";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../../src/cli/firefox-lldb-server.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { runRepl } from "../../src/cli/repl.ts";
import { FIXTURES, startStaticServer, withDeadline } from "./harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export class ReplSession {
  #client;
  #handle;
  #staticServer;
  #sockets = new Set();
  #input;
  #repl;
  #out = "";
  #waiters = [];
  #triggerInterrupt;
  session;

  async #bridgeTcp(port) {
    const channelId = await this.#client.createChannel();
    const socket = net.connect(port, "127.0.0.1");
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("data", (d) => void this.#client.channelServerWrite(channelId, new Uint8Array(d)));
    socket.on("error", () => {});
    // Register before bridgeChannel: on loopback the TCP handshake completes
    // while bridgeChannel awaits, and a post-await socket.once("connect") misses
    // the already-fired event, leaving the promise permanently unresolved.
    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await this.#client.bridgeChannel(channelId, (data) => void socket.write(Buffer.from(data)));
    await connected;
    return channelId;
  }

  #settle() {
    return new Promise((resolve) => {
      const check = () => {
        if (stripAnsi(this.#out).trimEnd().endsWith("(lldb)")) resolve();
        else this.#waiters.push(check);
      };
      check();
    });
  }

  // Launch the fixture, attach, then start the REPL. Returns once the (lldb)
  // prompt is live and ready for type().
  static async attach(fxName, { headless = true, fire } = {}) {
    const fx = FIXTURES[fxName];
    if (!fx) throw new Error(`unknown fixture: ${fxName}`);
    const staticServer = await startStaticServer(fx.pageDir);
    const url = `http://127.0.0.1:${staticServer.port}/index.html`;

    const client = await LLDBClient.create();
    const rs = new ReplSession();
    rs.#client = client;
    rs.#staticServer = staticServer;
    client.setFileProvider(() => Promise.resolve(null));

    const output = new Writable({
      write: (chunk, _enc, cb) => {
        rs.#out += chunk.toString();
        rs.#waiters.splice(0).forEach((w) => w());
        cb();
      },
    });
    rs.#input = new PassThrough();
    rs.#repl = runRepl({
      client,
      getSession: () => rs.session,
      input: rs.#input,
      output,
      onTargetInterrupt: () => rs.#triggerInterrupt?.(),
    });

    return withDeadline(
      rs,
      (async () => {
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
          wrapConnectPort: (port) => rs.#bridgeTcp(port),
          onSession: (s, interrupt) => {
            rs.session = s;
            rs.#triggerInterrupt = interrupt;
            void s.streamConsole((m) => rs.#repl.printConsole(m));
          },
        });
        rs.#handle = handle;

        const c0 = await rs.#bridgeTcp(handle.port);
        await client.sessionCommand("platform select remote-gdb-server");
        const conn = await client.sessionCommand(`platform connect inprocess://${c0}`);
        if (conn.status >= 6) throw new Error(`platform connect failed: ${conn.error}`);
        await client.sessionCommand("command alias attach process attach --plugin wasm");

        // Cold launch + wasm load can exceed the attach timeout; retry like
        // the Session harness. Attach is driven directly (not through the
        // REPL) so the retry policy is in one place; REPL command routing is
        // what the tests exercise afterwards.
        let lastErr = "";
        for (let attempt = 0; attempt < 4; attempt++) {
          const res = await client.sessionCommand("process attach --plugin wasm --pid 1");
          if (res.status < 6) {
            const st = await client.sessionState();
            if (st.reason !== "none" && st.reason !== "exited") {
              rs.#repl.start();
              await rs.#settle();
              return rs;
            }
            lastErr = `attach left process in state ${st.reason}`;
          } else {
            lastErr = res.error;
          }
          await sleep(1000);
        }
        throw new Error(`process attach failed after retries: ${lastErr}`);
      })(),
      60_000
    );
  }

  // Type a command line into the REPL and resolve with the output it produced
  // (ANSI stripped), once a fresh prompt returns. #settle() has no timeout of
  // its own -- if the underlying process wedges mid-test, this would hang
  // forever unprotected (see Session's #withCommandDeadline in harness.mjs
  // for the same gap on the other harness).
  async type(line) {
    const mark = this.#out.length;
    this.#input.write(line + "\n");
    await withDeadline(this, this.#settle(), 30_000);
    return stripAnsi(this.#out.slice(mark));
  }

  interrupt() {
    this.#input.write("\x03");
  }

  waitFor(text, ms = 8000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const check = () => {
        if (this.#out.includes(text)) return resolve();
        if (Date.now() > deadline)
          return reject(
            new Error(
              `timeout waiting for ${JSON.stringify(text)}; got: ${JSON.stringify(this.#out.slice(-300))}`
            )
          );
        this.#waiters.push(check);
      };
      check();
    });
  }

  output() {
    return stripAnsi(this.#out);
  }

  async shutdown() {
    for (const s of this.#sockets) s.destroy();
    await this.#handle?.shutdown().catch(() => {});
    await this.#client.destroy();
    await new Promise((resolve) => this.#staticServer?.server.close(resolve));
  }

  // See Session.forceKillFirefox in harness.mjs.
  forceKillFirefox() {
    const pid = this.#handle?.firefoxPid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}
