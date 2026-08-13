/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { noopLogger, type Logger } from "../logging.js";
import type { GdbRspConnection, GdbRspEndpoint, SourceDebuggerComponentHost } from "./component.js";
import {
  connectRspByteChannel,
  openTcpRspByteChannel,
  type HostRspByteChannel,
} from "./rsp-byte-channel.js";
import type { ComponentId } from "./types.js";
import { FirefoxWasmDebuggee, type WasmDebuggee } from "./wasm-debuggee.js";
import type { RdpWasmSession } from "../rdp/session.js";

interface RegisteredRspEndpoint {
  componentId: ComponentId;
  tcpPort: number;
  kind: GdbRspEndpoint["kind"];
}

/** A component-scoped view of the session host. The scope is the authority:
 * an endpoint registered for one component cannot be consumed by a sibling. */
export interface SourceDebuggerComponentHostBinding extends SourceDebuggerComponentHost {
  readonly componentId: ComponentId;
  registerGdbRspEndpoint(tcpPort: number, kind: GdbRspEndpoint["kind"]): GdbRspEndpoint;
  discardGdbRspEndpoint(endpoint: GdbRspEndpoint): void;
  /** MessagePort transport adapter used by the TypeScript isolate loader. A
   * Component Model host will transfer the connection resource directly. */
  openGdbRspChannel(endpoint: GdbRspEndpoint): Promise<HostRspByteChannel>;
}

/** Owns imported debuggee capabilities for the lifetime of one logical source
 * debugging session. It issues one-shot opaque endpoints and retains all live
 * TCP bridges so session shutdown can revoke them centrally. */
export class SourceDebuggerSessionHost {
  readonly #logger: Logger;
  readonly #rdpSession: RdpWasmSession | undefined;
  readonly #canAccessWasmModule:
    | ((componentId: ComponentId, moduleId: string) => boolean)
    | undefined;
  readonly #bindings = new Map<ComponentId, SourceDebuggerComponentHostBinding>();
  readonly #endpoints = new Map<string, RegisteredRspEndpoint>();
  readonly #channels = new Set<HostRspByteChannel>();
  readonly #wasmDebuggees = new Set<WasmDebuggee>();
  #nextEndpointId = 1;
  #closed = false;

  constructor(
    options: {
      logger?: Logger;
      rdpSession?: RdpWasmSession;
      canAccessWasmModule?: (componentId: ComponentId, moduleId: string) => boolean;
    } = {}
  ) {
    this.#logger = options.logger ?? noopLogger;
    this.#rdpSession = options.rdpSession;
    this.#canAccessWasmModule = options.canAccessWasmModule;
  }

  forComponent(componentId: ComponentId): SourceDebuggerComponentHostBinding {
    if (!componentId) throw new Error("SourceDebuggerComponent host binding requires an id");
    if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
    const existing = this.#bindings.get(componentId);
    if (existing) return existing;

    const binding: SourceDebuggerComponentHostBinding = {
      componentId,
      registerGdbRspEndpoint: (tcpPort, kind) =>
        this.#registerGdbRspEndpoint(componentId, tcpPort, kind),
      discardGdbRspEndpoint: (endpoint) => this.#discardGdbRspEndpoint(componentId, endpoint),
      openGdbRspChannel: (endpoint) => this.#openGdbRspChannel(componentId, endpoint),
      connectGdbRsp: async (endpoint): Promise<GdbRspConnection> => {
        const channel = await this.#openGdbRspChannel(componentId, endpoint);
        return connectRspByteChannel(channel.componentPort);
      },
      openWasmDebuggee: async (): Promise<WasmDebuggee> => {
        if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
        if (!this.#rdpSession) {
          throw new Error("SourceDebuggerSessionHost has no direct Wasm debuggee target");
        }
        const debuggee = new FirefoxWasmDebuggee(
          this.#rdpSession,
          this.#canAccessWasmModule
            ? (moduleId) => this.#canAccessWasmModule!(componentId, moduleId)
            : undefined
        );
        this.#wasmDebuggees.add(debuggee);
        return debuggee;
      },
    };
    this.#bindings.set(componentId, binding);
    return binding;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#endpoints.clear();
    this.#bindings.clear();
    for (const debuggee of this.#wasmDebuggees) debuggee.dispose();
    this.#wasmDebuggees.clear();
    for (const channel of this.#channels) channel.close();
    this.#channels.clear();
  }

  #registerGdbRspEndpoint(
    componentId: ComponentId,
    tcpPort: number,
    kind: GdbRspEndpoint["kind"]
  ): GdbRspEndpoint {
    if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
    if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65_535) {
      throw new Error(`invalid ${kind} GDB RSP TCP port ${tcpPort}`);
    }
    const endpoint = {
      id: `rsp-${this.#nextEndpointId++}`,
      kind,
    } satisfies GdbRspEndpoint;
    this.#endpoints.set(endpoint.id, { componentId, tcpPort, kind });
    return endpoint;
  }

  #discardGdbRspEndpoint(componentId: ComponentId, endpoint: GdbRspEndpoint): void {
    const registered = this.#endpoints.get(endpoint.id);
    if (registered?.componentId === componentId && registered.kind === endpoint.kind) {
      this.#endpoints.delete(endpoint.id);
    }
  }

  async #openGdbRspChannel(
    componentId: ComponentId,
    endpoint: GdbRspEndpoint
  ): Promise<HostRspByteChannel> {
    if (this.#closed) throw new Error("SourceDebuggerSessionHost is closed");
    const registered = this.#endpoints.get(endpoint.id);
    if (
      !registered ||
      registered.componentId !== componentId ||
      registered.kind !== endpoint.kind
    ) {
      throw new Error(`unknown ${endpoint.kind} GDB RSP endpoint ${endpoint.id}`);
    }
    this.#endpoints.delete(endpoint.id);

    const channel = await openTcpRspByteChannel(registered.tcpPort, {
      logger: this.#logger,
      label: `${componentId} ${endpoint.kind} ${endpoint.id}`,
    });
    if (this.#closed) {
      channel.close();
      throw new Error("SourceDebuggerSessionHost closed while opening a GDB RSP connection");
    }
    this.#channels.add(channel);
    void channel.closed.then(() => this.#channels.delete(channel));
    return channel;
  }
}
