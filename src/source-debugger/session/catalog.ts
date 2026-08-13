/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  LoadedSourceDebuggerComponentDefinition,
  SourceDebuggerComponentLoader,
} from "./loader.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import type { ComponentId } from "../protocol/types.js";
import { validateComponentDescriptor } from "../protocol/validation.js";

export interface SourceDebuggerCatalogEntry extends SourceDebuggerComponentProbe {
  readonly loader: SourceDebuggerComponentLoader;
  readonly loadedDefinition: LoadedSourceDebuggerComponentDefinition;
}

/** Installed ecosystem definitions. Loading this catalog must not instantiate
 * a language debugger engine or connect one to the target. */
export class SourceDebuggerComponentCatalog {
  readonly entries: readonly SourceDebuggerCatalogEntry[];
  readonly #entryById: Map<ComponentId, SourceDebuggerCatalogEntry>;
  #closed = false;

  private constructor(entries: SourceDebuggerCatalogEntry[]) {
    this.entries = entries;
    this.#entryById = new Map(entries.map((entry) => [entry.id, entry]));
  }

  static async load(
    loaders: readonly SourceDebuggerComponentLoader[]
  ): Promise<SourceDebuggerComponentCatalog> {
    if (loaders.length === 0) {
      throw new Error("SourceDebuggerComponent catalog requires at least one loader");
    }
    const loaderIds = loaders.map(({ id }) => id);
    if (loaderIds.some((id) => !id)) {
      throw new Error("SourceDebuggerComponent loader ids must not be empty");
    }
    if (new Set(loaderIds).size !== loaderIds.length) {
      throw new Error("SourceDebuggerComponent loader ids must be unique");
    }

    const entries: SourceDebuggerCatalogEntry[] = [];
    try {
      for (const loader of loaders) {
        const loadedDefinition = await loader.loadDefinition();
        const descriptor = validateComponentDescriptor(
          await loadedDefinition.definition.describe(),
          loader.id
        );
        if (loadedDefinition.id !== loader.id || descriptor.id !== loader.id) {
          await Promise.resolve(loadedDefinition.close()).catch(() => {});
          throw new Error(
            `SourceDebuggerComponent loader id ${loader.id} does not match definition ids ${loadedDefinition.id}/${descriptor.id}`
          );
        }
        entries.push({
          id: loader.id,
          loader,
          loadedDefinition,
          probeModule: (module) => loadedDefinition.definition.probeModule(module),
        });
      }
      return new SourceDebuggerComponentCatalog(entries);
    } catch (error) {
      await closeDefinitions(entries);
      throw error;
    }
  }

  probes(): readonly SourceDebuggerComponentProbe[] {
    return this.entries;
  }

  entry(id: ComponentId): SourceDebuggerCatalogEntry {
    const entry = this.#entryById.get(id);
    if (!entry) throw new Error(`unknown installed SourceDebuggerComponent ${id}`);
    return entry;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await closeDefinitions(this.entries);
  }
}

async function closeDefinitions(entries: readonly SourceDebuggerCatalogEntry[]): Promise<void> {
  for (const { loadedDefinition } of [...entries].reverse()) {
    await Promise.resolve(loadedDefinition.close()).catch(() => {});
  }
}
