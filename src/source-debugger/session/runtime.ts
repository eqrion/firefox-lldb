/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger } from "../../logging.js";
import { SourceDebuggerComponentCatalog } from "./catalog.js";
import { SourceDebuggerSessionHost } from "../target/host.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentActivation,
  SourceDebuggerComponentLoader,
} from "./loader.js";
import {
  createProbeModuleOwnerResolver,
  type ModuleOwnerResolver,
  type SourceDebuggerComponentProbe,
} from "./ownership.js";
import { SourceDebuggerSession } from "./session.js";
import type { SourceDebuggerTarget } from "../protocol/target.js";

export interface SourceDebuggerSessionRuntimeOptions {
  loaders: readonly SourceDebuggerComponentLoader[];
  target?: SourceDebuggerTarget;
  host?: SourceDebuggerSessionHost;
  createModuleOwnerResolver?: (
    definitions: readonly SourceDebuggerComponentProbe[]
  ) => ModuleOwnerResolver;
  /** Compatibility components which must observe every stop even if no
   * currently-loaded module selected them. */
  eagerComponentIds?: readonly string[];
  /** Components to instantiate only when discovery sees no initial modules
   * (for example the interactive attach-without-URL path). */
  fallbackComponentIds?: readonly string[];
  logger?: Logger;
}

/** Owns the host-side lifecycle around the language-generic session: load each
 * installed ecosystem, construct the broker, activate target connections, and
 * tear everything down in dependency order. */
export class SourceDebuggerSessionRuntime {
  readonly session: SourceDebuggerSession;
  readonly catalog: SourceDebuggerComponentCatalog;
  readonly #host: SourceDebuggerSessionHost;
  readonly #target: SourceDebuggerTarget | undefined;
  readonly #components: LoadedSourceDebuggerComponent[];
  readonly #lateActivations = new Map<string, Promise<LoadedSourceDebuggerComponent>>();
  #activationPromise: Promise<SourceDebuggerComponentActivation> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    host: SourceDebuggerSessionHost,
    catalog: SourceDebuggerComponentCatalog,
    components: LoadedSourceDebuggerComponent[],
    resolveModuleOwner: ModuleOwnerResolver,
    options: SourceDebuggerSessionRuntimeOptions
  ) {
    this.#host = host;
    this.#target = options.target;
    this.catalog = catalog;
    this.#components = components;
    this.session = new SourceDebuggerSession({
      components: components.map(({ component }) => component),
      debuggeeHost: host,
      target: options.target,
      resolveModuleOwner,
      ensureComponent: async (id) => (await this.#ensureComponent(id)).component,
      logger: options.logger,
    });
  }

  get components(): readonly LoadedSourceDebuggerComponent[] {
    return this.#components;
  }

  static async load(
    options: SourceDebuggerSessionRuntimeOptions
  ): Promise<SourceDebuggerSessionRuntime> {
    const host =
      options.host ??
      new SourceDebuggerSessionHost({
        logger: options.logger,
        canAccessWasmModule: (componentId, moduleId) =>
          options.target?.moduleOwner?.(moduleId) === componentId,
      });
    let catalog: SourceDebuggerComponentCatalog | undefined;
    const components: LoadedSourceDebuggerComponent[] = [];
    try {
      catalog = await SourceDebuggerComponentCatalog.load(options.loaders);
      const resolveModuleOwner =
        options.createModuleOwnerResolver?.(catalog.probes()) ??
        createProbeModuleOwnerResolver(catalog.probes());
      const modules = (await options.target?.modules()) ?? [];
      const selectedIds = new Set(options.eagerComponentIds ?? []);
      if (modules.length === 0) {
        for (const id of options.fallbackComponentIds ?? []) selectedIds.add(id);
      } else {
        for (const module of modules) {
          const owner = await resolveModuleOwner(module);
          selectedIds.add(owner);
          options.target?.assignModuleOwner?.(module.id, owner);
        }
      }
      if (selectedIds.size === 0) {
        throw new Error(
          "SourceDebuggerComponent discovery selected no components; configure a fallback for targets without loaded modules"
        );
      }
      for (const id of selectedIds) catalog.entry(id);

      for (const entry of catalog.entries) {
        if (!selectedIds.has(entry.id)) continue;
        const loaded = await entry.loader.instantiate(host.forComponent(entry.id));
        if (loaded.id !== entry.id) {
          await loaded.close();
          throw new Error(
            `SourceDebuggerComponent loader id ${entry.id} does not match loaded component id ${loaded.id}`
          );
        }
        components.push(loaded);
      }
      return new SourceDebuggerSessionRuntime(
        host,
        catalog,
        components,
        resolveModuleOwner,
        options
      );
    } catch (error) {
      await closeComponents(components);
      host.close();
      await catalog?.close();
      await Promise.resolve(options.target?.close()).catch(() => {});
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
    await Promise.allSettled(this.#lateActivations.values());
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
    try {
      await this.catalog.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#target?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "source debugger runtime cleanup failed");
  }

  #ensureComponent(id: string): Promise<LoadedSourceDebuggerComponent> {
    const existing = this.#components.find((component) => component.id === id);
    if (existing) return Promise.resolve(existing);
    if (this.#closePromise) {
      return Promise.reject(new Error("SourceDebuggerSessionRuntime is closed"));
    }
    if (!this.#activationPromise) {
      return Promise.reject(
        new Error(
          `cannot activate late SourceDebuggerComponent ${id} before the session runtime is active`
        )
      );
    }

    const pending = this.#lateActivations.get(id);
    if (pending) return pending;
    const activation = this.#activateLateComponent(id).finally(() => {
      this.#lateActivations.delete(id);
    });
    this.#lateActivations.set(id, activation);
    return activation;
  }

  async #activateLateComponent(id: string): Promise<LoadedSourceDebuggerComponent> {
    await this.#activationPromise;
    const existing = this.#components.find((component) => component.id === id);
    if (existing) return existing;
    if (this.#closePromise) throw new Error("SourceDebuggerSessionRuntime is closed");

    const entry = this.catalog.entry(id);
    const loaded = await entry.loader.instantiate(this.#host.forComponent(id));
    if (loaded.id !== id) {
      await loaded.close();
      throw new Error(
        `SourceDebuggerComponent loader id ${id} does not match loaded component id ${loaded.id}`
      );
    }
    try {
      await loaded.activate();
      if (this.#closePromise) {
        throw new Error("SourceDebuggerSessionRuntime closed during late component activation");
      }
      this.#components.push(loaded);
      return loaded;
    } catch (error) {
      await Promise.resolve(loaded.close()).catch(() => {});
      throw error;
    }
  }
}

async function closeComponents(
  components: readonly LoadedSourceDebuggerComponent[]
): Promise<void> {
  for (const component of [...components].reverse()) {
    await Promise.resolve(component.close()).catch(() => {});
  }
}
