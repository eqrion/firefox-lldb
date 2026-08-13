/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel, type MessagePort } from "node:worker_threads";
import type {
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
} from "../protocol/component.js";
import { serveSourceDebuggerComponentHost } from "./host-rpc.js";
import {
  connectSourceDebuggerComponent,
  serveSourceDebuggerComponent,
  type SourceDebuggerRpcEndpoint,
  type SourceDebuggerRpcOptions,
  type RemoteSourceDebuggerComponent,
} from "./rpc.js";
import { validateComponentDescriptor } from "../protocol/validation.js";

export interface SourceDebuggerComponentWorkerPorts {
  componentPort: MessagePort;
  hostPort: MessagePort;
}

/** Host-side half of the generic TypeScript isolate transport. Engine-specific
 * code only has to put workerPorts in its worker data and signal readiness;
 * instance, imported-host, deadlines, and identity checks live here for every
 * debugger ecosystem. Component definitions stay in the host-side catalog. */
export class SourceDebuggerComponentIsolate {
  readonly workerPorts: SourceDebuggerComponentWorkerPorts;
  readonly transferList: MessagePort[];
  readonly #componentPort: MessagePort;
  readonly #hostEndpoint: SourceDebuggerRpcEndpoint;
  #component: RemoteSourceDebuggerComponent | undefined;
  #closed = false;

  constructor(
    host: SourceDebuggerComponentHost,
    private readonly options: SourceDebuggerRpcOptions = {}
  ) {
    const componentChannel = new MessageChannel();
    const hostChannel = new MessageChannel();
    this.#componentPort = componentChannel.port1;
    this.#hostEndpoint = serveSourceDebuggerComponentHost(hostChannel.port1, host);
    this.workerPorts = {
      componentPort: componentChannel.port2,
      hostPort: hostChannel.port2,
    };
    this.transferList = Object.values(this.workerPorts);
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("SourceDebuggerComponent isolate transport is closed");
    if (this.#component) throw new Error("SourceDebuggerComponent isolate is already connected");
    try {
      this.#component = await connectSourceDebuggerComponent(this.#componentPort, this.options);
      validateComponentDescriptor(await this.#component.describe(), this.#component.id);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get component(): SourceDebuggerComponent {
    if (!this.#component) throw new Error("SourceDebuggerComponent isolate is not connected");
    return this.#component;
  }

  get id(): string {
    return this.component.id;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#component?.close();
    if (!this.#component) this.#componentPort.close();
    this.#hostEndpoint.close();
  }
}

/** Worker-side export wiring shared by all TypeScript component isolates. */
export function serveSourceDebuggerComponentIsolate(
  ports: Pick<SourceDebuggerComponentWorkerPorts, "componentPort">,
  component: SourceDebuggerComponent
): SourceDebuggerRpcEndpoint {
  return serveSourceDebuggerComponent(ports.componentPort, component);
}
