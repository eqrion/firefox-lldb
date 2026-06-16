// Manages the per-tab GDB servers the platform spawns on qLaunchGDBServer.
//
// Each "GDB server" is created by the injected launcher, which builds an
// RdpDebuggee over an RdpWasmSession and serves it via the worker-hosted
// gdbstub component. The launcher is injected so this stays decoupled from
// the wasm and RDP implementation.

import net from "node:net";
import type { AddressInfo } from "node:net";

export interface LaunchedServer {
  stop(): void | Promise<void>;
}

export type GdbServerLauncher = (opts: { port: number; url?: string }) => Promise<LaunchedServer>;

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

  /** Launch a GDB server. When requestedPort is 0 a free port is pre-allocated. */
  async launch(requestedPort = 0, url?: string): Promise<SpawnedServer> {
    const port = requestedPort !== 0 ? requestedPort : await freePort();
    const handle = await this.#launcher({ port, url });
    const pid = this.#nextPid++;
    this.#servers.set(pid, { port, handle });
    return { pid, port };
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
    await Promise.all([...this.#servers.values()].map((e) => e.handle.stop()));
    this.#servers.clear();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}
