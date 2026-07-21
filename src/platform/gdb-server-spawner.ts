/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Manages the per-tab GDB servers the platform spawns on qLaunchGDBServer.
//
// Each "GDB server" is created by the injected launcher, which builds an
// RdpDebuggee over an RdpWasmSession and serves it via the worker-hosted
// gdbstub component. The launcher is injected so this stays decoupled from
// the wasm and RDP implementation.

import net from "node:net";
import type { AddressInfo } from "node:net";

export interface LaunchedServer {
  port: number;
  stop(): void | Promise<void>;
}

export type GdbServerLauncher = (opts: {
  port: number;
  url?: string;
  tabActor?: string;
}) => Promise<LaunchedServer>;

export interface SpawnedServer {
  pid: number;
  port: number;
}

export class GdbServerSpawner {
  #launcher: GdbServerLauncher;
  #servers = new Map<number, { port: number; handle: LaunchedServer }>();
  #nextPid = 0x10000;

  constructor(launcher: GdbServerLauncher) {
    this.#launcher = launcher;
  }

  /** Launch a GDB server. Port 0 lets the launcher pick its own port. */
  async launch(requestedPort = 0, url?: string, tabActor?: string): Promise<SpawnedServer> {
    const handle = await this.#launcher({ port: requestedPort, url, tabActor });
    const pid = this.#nextPid++;
    this.#servers.set(pid, { port: handle.port, handle });
    return { pid, port: handle.port };
  }

  async kill(pid: number): Promise<boolean> {
    const entry = this.#servers.get(pid);
    if (!entry) return false;
    this.#servers.delete(pid);
    await entry.handle.stop();
    return true;
  }

  list(): SpawnedServer[] {
    return [...this.#servers].map(([pid, { port }]) => ({ pid, port }));
  }

  async killAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#servers.values()].map((e) => Promise.resolve(e.handle.stop()))
    );
    this.#servers.clear();
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    if (errors.length) throw new AggregateError(errors, "failed to stop one or more GDB servers");
  }
}

// TOCTOU: we probe an OS-assigned port, release it, then hand the number to
// Firefox via --start-debugger-server. Firefox doesn't support port 0, so
// there's no way to eliminate the race. The window is tiny in practice and
// Session.attach() retries on failure.
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
