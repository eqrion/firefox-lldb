// Manages the per-tab GDB servers the platform spawns on qLaunchGDBServer.
//
// In LLDB's native platform this forks an `lldb-server gdbserver` process; here
// each "GDB server" is an in-process RspServer bound to its own TCP port whose
// handler speaks the wasm protocol (built in M2+). The handler is injected so
// this stays decoupled from the wasm implementation.

import { RspServer, type RspHandler, type RspLogger } from "../protocol/rsp-server.js";

export interface SpawnedServer {
  pid: number;
  port: number;
}

export class GdbServerSpawner {
  #handlerFactory: () => RspHandler;
  #logger?: RspLogger;
  #servers = new Map<number, RspServer>();
  #nextPid = 0x10000;

  constructor(handlerFactory: () => RspHandler, logger?: RspLogger) {
    this.#handlerFactory = handlerFactory;
    this.#logger = logger;
  }

  /** Launch a GDB server. requestedPort 0 lets the OS pick a free port. */
  async launch(requestedPort = 0): Promise<SpawnedServer> {
    const server = new RspServer(this.#handlerFactory, {
      logger: this.#logger,
      singleConnection: true,
    });
    const port = await server.listen(requestedPort);
    const pid = this.#nextPid++;
    this.#servers.set(pid, server);
    return { pid, port };
  }

  async kill(pid: number): Promise<boolean> {
    const server = this.#servers.get(pid);
    if (!server) return false;
    this.#servers.delete(pid);
    await server.close();
    return true;
  }

  list(): SpawnedServer[] {
    return [...this.#servers].map(([pid, server]) => ({ pid, port: server.port }));
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.#servers.values()].map((s) => s.close()));
    this.#servers.clear();
  }
}
