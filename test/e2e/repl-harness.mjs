/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// REPL-level e2e harness: boots the production Firefox target, component
// catalog/loaders, and SourceDebuggerSessionRuntime, then drives the real
// runRepl with injected streams. It intentionally has no direct LLDB client,
// platform server, RSP socket, or gdbstub access.

import { PassThrough, Writable } from "node:stream";
import { runRepl } from "../../src/cli/repl.ts";
import { SourceDebuggerTestSession } from "./support/source-debugger-session.ts";

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function deadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ReplSession {
  #testSession;
  #input;
  #repl;
  #out = "";
  #waiters = [];
  session;

  #settle(mark = 0) {
    return new Promise((resolve) => {
      const check = () => {
        if (stripAnsi(this.#out.slice(mark)).includes("(sdb) ")) resolve();
        else this.#waiters.push(check);
      };
      check();
    });
  }

  // Launch the fixture, attach, then start the REPL. Returns once the (sdb)
  // prompt is live and ready for type().
  static async attach(fxName, { headless = true, fire } = {}) {
    const rs = new ReplSession();
    const output = new Writable({
      write: (chunk, _enc, cb) => {
        rs.#out += chunk.toString();
        rs.#waiters.splice(0).forEach((w) => w());
        cb();
      },
    });
    rs.#input = new PassThrough();
    const testSession = await SourceDebuggerTestSession.attach(fxName, {
      headless,
      fire,
      onConsole: (message) => rs.#repl?.printConsole(message),
    });
    rs.#testSession = testSession;
    rs.session = testSession.rdpSession;
    rs.#repl = runRepl({
      session: testSession.session,
      getRdpSession: () => testSession.rdpSession,
      input: rs.#input,
      output,
      onTargetInterrupt: () => testSession.target.interrupt(),
    });
    rs.#repl.start(testSession.readyMessage);
    await rs.#settle();
    return rs;
  }

  // Type a command line into the REPL and resolve with the output it produced
  // (ANSI stripped), once a fresh prompt returns. #settle() has no timeout of
  // its own -- if the underlying process wedges mid-test, this would hang
  // forever unprotected (see Session's #withCommandDeadline in harness.mjs
  // for the same gap on the other harness).
  async type(line) {
    const mark = this.#out.length;
    this.#input.write(line + "\n");
    await deadline(
      this.#settle(mark),
      30_000,
      `REPL command timed out: ${line}; output: ${stripAnsi(this.#out.slice(mark).slice(-500))}`
    );
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
    this.#repl?.close();
    await this.#testSession?.shutdown();
  }
}
