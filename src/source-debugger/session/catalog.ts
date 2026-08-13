/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerComponentLoader } from "./loader.js";
import type { SourceDebuggerComponentDefinition } from "../protocol/component.js";
import type { SourceDebuggerComponentProbe } from "./ownership.js";
import type { ComponentId } from "../protocol/types.js";
import { validateComponentDescriptor } from "../protocol/validation.js";

export interface SourceDebuggerCatalogEntry extends SourceDebuggerComponentProbe {
  readonly loader: SourceDebuggerComponentLoader;
  readonly definition: SourceDebuggerComponentDefinition;
}

/** Installed ecosystem definitions. Loading this catalog must not instantiate
 * a language debugger engine or connect one to the target. */
export class SourceDebuggerComponentCatalog {
  readonly entries: readonly SourceDebuggerCatalogEntry[];
  readonly #entryById: Map<ComponentId, SourceDebuggerCatalogEntry>;
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
    const entries: SourceDebuggerCatalogEntry[] = [];
    for (const loader of loaders) {
      const descriptor = validateComponentDescriptor(await loader.definition.describe());
      if (entries.some(({ id }) => id === descriptor.id)) {
        throw new Error("SourceDebuggerComponent definition ids must be unique");
      }
      entries.push({
        id: descriptor.id,
        loader,
        definition: loader.definition,
        probeModule: (module) => loader.definition.probeModule(module),
      });
    }
    return new SourceDebuggerComponentCatalog(entries);
  }

  probes(): readonly SourceDebuggerComponentProbe[] {
    return this.entries;
  }

  entry(id: ComponentId): SourceDebuggerCatalogEntry {
    const entry = this.#entryById.get(id);
    if (!entry) throw new Error(`unknown installed SourceDebuggerComponent ${id}`);
    return entry;
  }
}
