/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MessageChannel, type MessagePort } from "node:worker_threads";
import type {
  ModuleClaim,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "./component.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import { serveSourceDebuggerComponentHost } from "./host-rpc.js";
import type { LoadedSourceDebuggerComponent } from "./loader.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import {
  connectSourceDebuggerComponent,
  connectSourceDebuggerComponentDefinition,
  serveSourceDebuggerComponent,
  serveSourceDebuggerComponentDefinition,
  type SourceDebuggerRpcEndpoint,
  type SourceDebuggerRpcOptions,
  type RemoteSourceDebuggerComponentInstance,
} from "./rpc.js";
import type { ModuleDescriptor } from "./types.js";

export interface SourceDebuggerComponentWorkerPorts {
  definitionPort: MessagePort;
  componentPort: MessagePort;
  hostPort: MessagePort;
}

/** Host-side half of the generic TypeScript isolate transport. Engine-specific
 * code only has to put workerPorts in its worker data and signal readiness;
 * definition, instance, imported-host, deadlines, and identity checks live
 * here for every debugger ecosystem. */
export class SourceDebuggerComponentIsolate
  implements SourceDebuggerComponentProbe, LoadedSourceDebuggerComponent
{
  readonly workerPorts: SourceDebuggerComponentWorkerPorts;
  readonly transferList: MessagePort[];
  readonly #definitionPort: MessagePort;
  readonly #componentPort: MessagePort;
  readonly #hostEndpoint: SourceDebuggerRpcEndpoint;
  readonly #hostComponentId: string;
  #definition: (SourceDebuggerComponentDefinition & SourceDebuggerRpcEndpoint) | undefined;
  #component: RemoteSourceDebuggerComponentInstance | undefined;
  #closed = false;

  constructor(
    host: SourceDebuggerComponentHostBinding,
    private readonly options: SourceDebuggerRpcOptions = {}
  ) {
    const definitionChannel = new MessageChannel();
    const componentChannel = new MessageChannel();
    const hostChannel = new MessageChannel();
    this.#definitionPort = definitionChannel.port1;
    this.#componentPort = componentChannel.port1;
    this.#hostComponentId = host.componentId;
    this.#hostEndpoint = serveSourceDebuggerComponentHost(hostChannel.port1, host);
    this.workerPorts = {
      definitionPort: definitionChannel.port2,
      componentPort: componentChannel.port2,
      hostPort: hostChannel.port2,
    };
    this.transferList = Object.values(this.workerPorts);
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new Error("SourceDebuggerComponent isolate transport is closed");
    if (this.#component) throw new Error("SourceDebuggerComponent isolate is already connected");
    try {
      this.#definition = connectSourceDebuggerComponentDefinition(
        this.#definitionPort,
        this.options
      );
      this.#component = await connectSourceDebuggerComponent(this.#componentPort, this.options);
      const descriptor = await this.#definition.describe();
      if (descriptor.id !== this.#component.id) {
        throw new Error(
          `SourceDebuggerComponent definition id ${descriptor.id} does not match instance id ${this.#component.id}`
        );
      }
      if (descriptor.id !== this.#hostComponentId) {
        throw new Error(
          `SourceDebuggerComponent definition id ${descriptor.id} does not match host binding id ${this.#hostComponentId}`
        );
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get definition(): SourceDebuggerComponentDefinition {
    if (!this.#definition) throw new Error("SourceDebuggerComponent isolate is not connected");
    return this.#definition;
  }

  get component(): SourceDebuggerComponentInstance {
    if (!this.#component) throw new Error("SourceDebuggerComponent isolate is not connected");
    return this.#component;
  }

  get id(): string {
    return this.component.id;
  }

  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return this.definition.probeModule(module);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#definition?.close();
    this.#component?.close();
    this.#definitionPort.close();
    if (!this.#component) this.#componentPort.close();
    this.#hostEndpoint.close();
  }
}

/** Worker-side export wiring shared by all TypeScript component isolates. */
export function serveSourceDebuggerComponentIsolate(
  ports: Pick<SourceDebuggerComponentWorkerPorts, "definitionPort" | "componentPort">,
  definition: SourceDebuggerComponentDefinition,
  component: SourceDebuggerComponentInstance
): SourceDebuggerRpcEndpoint {
  const definitionEndpoint = serveSourceDebuggerComponentDefinition(
    ports.definitionPort,
    definition
  );
  const componentEndpoint = serveSourceDebuggerComponent(ports.componentPort, component);
  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      definitionEndpoint.close();
      componentEndpoint.close();
    },
  };
}
