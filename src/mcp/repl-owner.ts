/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PtyCleanupError, PtyRepl, type LaunchOptions } from "./pty-repl.js";
import { freePort } from "../platform/gdb-server-spawner.js";

/** One CLI lifetime, including replacement and a launch not yet at its prompt. */
export class ReplOwner {
  #current?: PtyRepl;
  #pending?: AbortController;
  #revision = 0;
  #changing = false;
  #closed = false;
  #changes: Promise<void> = Promise.resolve();
  #closing?: Promise<void>;
  #failure?: unknown;

  get active(): PtyRepl | undefined {
    return this.#changing || this.#closed || this.#failure ? undefined : this.#current;
  }

  replace(options: Omit<LaunchOptions, "rdpPort" | "signal">): Promise<PtyRepl> {
    if (this.#closed) return Promise.reject(new Error("REPL owner is closed"));
    const revision = ++this.#revision;
    this.#changing = true;
    this.#pending?.abort(new Error("REPL launch superseded"));
    const work = this.#changes
      .then(async () => {
        if (this.#failure) throw this.#failure;
        if (revision !== this.#revision || this.#closed) throw new Error("REPL launch superseded");
        await this.#stopCurrent();
        // Shutdown above can overlap another replacement request.
        if (revision !== this.#revision || this.#closed) throw new Error("REPL launch superseded");
        const abort = new AbortController();
        this.#pending = abort;
        try {
          const rdpPort = await freePort();
          abort.signal.throwIfAborted();
          const repl = await PtyRepl.launch({ ...options, rdpPort, signal: abort.signal });
          this.#current = repl;
          if (revision !== this.#revision || this.#closed) {
            await this.#stopCurrent();
            throw new Error("REPL launch superseded");
          }
          return repl;
        } catch (error) {
          if (error instanceof PtyCleanupError) this.#failure ??= error;
          throw error;
        } finally {
          this.#pending = undefined;
        }
      })
      .finally(() => {
        if (revision === this.#revision) this.#changing = false;
      });
    this.#changes = work.then(
      () => {},
      () => {}
    );
    return work;
  }

  shutdown(): Promise<void> {
    ++this.#revision;
    const revision = this.#revision;
    this.#changing = true;
    this.#pending?.abort(new Error("REPL launch cancelled by shutdown"));
    const work = this.#changes
      .then(async () => {
        await this.#stopCurrent();
        if (this.#failure) throw this.#failure;
      })
      .finally(() => {
        if (revision === this.#revision) this.#changing = false;
      });
    this.#changes = work.catch(() => {});
    return work;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = this.shutdown());
  }

  async #stopCurrent(): Promise<void> {
    try {
      await this.#current?.shutdown();
      this.#current = undefined;
    } catch (error) {
      this.#failure ??= new PtyCleanupError(
        [error],
        "REPL cleanup failed; restart the MCP server before launching again"
      );
      throw this.#failure;
    }
  }
}
