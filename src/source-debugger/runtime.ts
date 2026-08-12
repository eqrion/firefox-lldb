/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RdpWasmSession } from "../rdp/session.js";
import type { Logger } from "../logging.js";
import { SourceDebuggerSessionHost } from "./host.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentActivation,
  SourceDebuggerComponentLoader,
} from "./loader.js";
import type { ModuleOwnerResolver } from "./ownership.js";
import { SourceDebuggerSession } from "./session.js";

export interface SourceDebuggerSessionRuntimeOptions {
  loaders: readonly SourceDebuggerComponentLoader[];
  host?: SourceDebuggerSessionHost;
  getRdpSession?: () => RdpWasmSession | undefined;
  createModuleOwnerResolver?: (
    components: readonly LoadedSourceDebuggerComponent[]
  ) => ModuleOwnerResolver;
  logger?: Logger;
}

/** Owns the host-side lifecycle around the language-generic session: load each
 * installed ecosystem, construct the broker, activate target connections, and
 * tear everything down in dependency order. */
export class SourceDebuggerSessionRuntime {
  readonly session: SourceDebuggerSession;
  readonly components: readonly LoadedSourceDebuggerComponent[];
  readonly #host: SourceDebuggerSessionHost;
  #activationPromise: Promise<SourceDebuggerComponentActivation> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    host: SourceDebuggerSessionHost,
    components: LoadedSourceDebuggerComponent[],
    options: SourceDebuggerSessionRuntimeOptions
  ) {
    this.#host = host;
    this.components = components;
    this.session = new SourceDebuggerSession({
      components: components.map(({ component }) => component),
      debuggeeHost: host,
      getRdpSession: options.getRdpSession,
      resolveModuleOwner: options.createModuleOwnerResolver?.(components),
      logger: options.logger,
    });
  }

  static async load(
    options: SourceDebuggerSessionRuntimeOptions
  ): Promise<SourceDebuggerSessionRuntime> {
    if (options.loaders.length === 0) {
      throw new Error("SourceDebuggerSessionRuntime requires at least one component loader");
    }
    const ids = options.loaders.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("SourceDebuggerComponent loader ids must be unique");
    }

    const host = options.host ?? new SourceDebuggerSessionHost({ logger: options.logger });
    const components: LoadedSourceDebuggerComponent[] = [];
    try {
      for (const loader of options.loaders) {
        const loaded = await loader.load(host.forComponent(loader.id));
        if (loaded.id !== loader.id) {
          await loaded.close();
          throw new Error(
            `SourceDebuggerComponent loader id ${loader.id} does not match loaded component id ${loaded.id}`
          );
        }
        components.push(loaded);
      }
      return new SourceDebuggerSessionRuntime(host, components, options);
    } catch (error) {
      await closeComponents(components);
      host.close();
      throw error;
    }
  }

  activate(): Promise<SourceDebuggerComponentActivation> {
    if (this.#closePromise) {
      return Promise.reject(new Error("SourceDebuggerSessionRuntime is closed"));
    }
    return (this.#activationPromise ??= this.#activate());
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #activate(): Promise<SourceDebuggerComponentActivation> {
    let readyMessage: string | undefined;
    try {
      for (const component of this.components) {
        const result = await component.activate();
        readyMessage ??= result?.readyMessage;
      }
      return readyMessage === undefined ? {} : { readyMessage };
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.session.close();
    } catch (error) {
      errors.push(error);
      this.#host.close();
    }
    for (const component of [...this.components].reverse()) {
      try {
        await component.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "source debugger runtime cleanup failed");
  }
}

async function closeComponents(
  components: readonly LoadedSourceDebuggerComponent[]
): Promise<void> {
  for (const component of [...components].reverse()) {
    await Promise.resolve(component.close()).catch(() => {});
  }
}
