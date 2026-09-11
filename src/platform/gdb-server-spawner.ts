/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns pending and live per-tab servers from registration through cleanup.
// The injected launcher owns RDP/component details and partial rollback.

import net from "node:net";
import type { AddressInfo } from "node:net";
import { noopLogger, type Logger } from "../diagnostics/logger.js";

export interface LaunchedServer {
  port: number;
  stop(): void | Promise<void>;
}

/** A rejected launch whose partial resources could not all be released. */
export class LaunchRollbackError extends AggregateError {
  constructor(launchError: unknown, rollbackError: unknown) {
    super([launchError, rollbackError], "per-tab launch and rollback failed");
  }
}

export type GdbServerLauncher = (opts: {
  port: number;
  url?: string;
  tabId?: number;
  /** Cancels acquisition only; the returned handle owns normal shutdown. */
  signal: AbortSignal;
}) => Promise<LaunchedServer>;

export interface SpawnedServer {
  pid: number;
  port: number;
}

interface OwnedServer {
  pid: number;
  ready: Promise<LaunchedServer>;
  handle?: LaunchedServer;
  stopping?: Promise<void>;
  failure?: string;
  abort: AbortController;
}

export class GdbServerSpawner {
  #launcher: GdbServerLauncher;
  #servers = new Map<number, OwnedServer>();
  #nextPid = 0x10000;
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    launcher: GdbServerLauncher,
    private readonly logger: Logger = noopLogger
  ) {
    this.#launcher = launcher;
  }

  /** Launch a GDB server. Port 0 lets the launcher pick its own port. */
  async launch(requestedPort = 0, url?: string, tabId?: number): Promise<SpawnedServer> {
    if (this.#closed) throw new Error("GDB server spawner is closed");
    const pid = this.#nextPid++;
    // Register before invoking user code, including a synchronous throw or a
    // launcher that re-enters shutdown. A late result always has an owner.
    const entry: OwnedServer = {
      pid,
      abort: new AbortController(),
      ready: Promise.resolve().then(() => {
        if (this.#closed) throw new Error(`GDB server launch ${pid} cancelled before starting`);
        return this.#launcher({ port: requestedPort, url, tabId, signal: entry.abort.signal });
      }),
    };
    this.#servers.set(pid, entry);
    this.logger.debug(`[spawner] launch.started ${JSON.stringify({ pid, requestedPort, tabId })}`);
    let handle: LaunchedServer;
    try {
      handle = await entry.ready;
    } catch (error) {
      if (error instanceof LaunchRollbackError) entry.failure = String(error);
      else this.#servers.delete(pid);
      this.logger.debug(`[spawner] launch.failed pid=${pid}: ${String(error)}`);
      throw error;
    }
    entry.handle = handle;
    if (this.#closed || entry.stopping) {
      await this.#stop(entry);
      throw new Error(`GDB server launch ${pid} cancelled by shutdown`);
    }
    this.logger.debug(`[spawner] launch.ready pid=${pid} port=${handle.port}`);
    return { pid, port: handle.port };
  }

  async kill(pid: number): Promise<boolean> {
    const entry = this.#servers.get(pid);
    if (!entry) return false;
    await this.#stop(entry);
    return true;
  }

  list(): SpawnedServer[] {
    return [...this.#servers.values()].flatMap((entry) =>
      entry.handle && !entry.stopping ? [{ pid: entry.pid, port: entry.handle.port }] : []
    );
  }

  #stop(entry: OwnedServer): Promise<void> {
    if (entry.stopping) return entry.stopping;
    this.logger.debug(`[spawner] stop.requested pid=${entry.pid}`);
    entry.stopping = entry.ready
      // A failed launcher owns rollback of its partial resources. A successful
      // one transfers its handle here, even if shutdown already timed out.
      .then(
        (handle) => handle.stop(),
        (error) => {
          if (error instanceof LaunchRollbackError) throw error;
        }
      )
      .then(
        () => {
          this.#servers.delete(entry.pid);
          this.logger.debug(
            `[spawner] stop.completed pid=${entry.pid} port=${entry.handle?.port ?? "none"}`
          );
        },
        (error) => {
          entry.failure = String(error);
          this.logger.error(`[spawner] stop.failed pid=${entry.pid}: ${String(error)}`);
          throw error;
        }
      );
    // Publish the shared stop promise before notifying cancellation listeners,
    // which can re-enter shutdown. Established handles use their normal stop.
    if (!entry.handle)
      entry.abort.abort(new Error(`GDB server launch ${entry.pid} cancelled by shutdown`));
    return entry.stopping;
  }

  logState(): void {
    this.logger.debug(
      `[spawner] snapshot ${JSON.stringify({
        closed: this.#closed,
        serverCount: this.#servers.size,
        servers: [...this.#servers.values()].slice(0, 20).map((entry) => ({
          pid: entry.pid,
          port: entry.handle?.port,
          state: entry.failure
            ? "stop-failed"
            : entry.stopping
              ? "stopping"
              : entry.handle
                ? "running"
                : "starting",
          awaitingLaunch: entry.handle === undefined,
          error: entry.failure,
        })),
      })}`
    );
  }

  /** Terminal shutdown. A timeout reports failure but retains late-launch ownership. */
  killAll(timeoutMs = 5000): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.logState();
    const drained = Promise.allSettled(
      [...this.#servers.values()].map((entry) => this.#stop(entry))
    ).then((results) => {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, "failed to stop one or more GDB servers");
    });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.logState();
        reject(
          new Error(
            `GDB server shutdown timed out after ${timeoutMs} ms; pending launches/stops remain owned`
          )
        );
      }, timeoutMs);
    });
    this.#closing = Promise.race([drained, timeout]).finally(() => clearTimeout(timer));
    return this.#closing;
  }
}

// Firefox requires a concrete RDP port. This probe cannot reserve it until
// Firefox binds; launch-token verification prevents connecting to the wrong owner.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}
