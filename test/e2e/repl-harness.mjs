/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// REPL-level e2e harness: boots the same Firefox + platform-server + bridge
// stack as harness.mjs, then drives the *real* runRepl (src/cli/repl.ts) with
// injected streams. This exercises the dominant `firefox-lldb` code path —
// readline routing, js subcommands, console streaming — rather than the
// lower-level session API the Session harness drives directly.

import { PassThrough, Writable } from "node:stream";
import { LLDBClient } from "lldb-wasm";
import { parseCliArgs, startPlatformServer } from "../../src/core/platform-session.ts";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";
import { runRepl } from "../../src/cli/repl.ts";
import {
  FIXTURES,
  startStaticServer,
  withDeadline,
  bridgeTcp,
  platformConnect,
  attachWithRetry,
  shutdownSession,
  forceKillFirefoxPid,
  retrySessionSetup,
} from "./harness.mjs";

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

  #bridgeTcp(port) {
    return bridgeTcp(this.#client, this.#sockets, port);
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
    return retrySessionSetup(() => ReplSession.#attachOnce(fx, { headless, fire }));
  }

  static async #attachOnce(fx, { headless, fire }) {
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
        await platformConnect(client, c0);
        await client.sessionCommand("command alias attach process attach --plugin wasm");

        // Attach is driven directly (not through the REPL) so the retry
        // policy is in one place; REPL command routing is what the tests
        // exercise afterwards.
        await attachWithRetry(client);
        rs.#repl.start();
        await rs.#settle();
        return rs;
      })(),
      30_000
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

  shutdown() {
    return shutdownSession({
      sockets: this.#sockets,
      handle: this.#handle,
      client: this.#client,
      staticServer: this.#staticServer,
    });
  }

  forceKillFirefox() {
    forceKillFirefoxPid(this.#handle?.firefoxPid);
  }
}
