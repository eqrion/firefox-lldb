/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns generation-scoped separate-DWARF registrations and bounded file reads.
// Embedded LLDB's file provider supplies the bytes; LLDB interprets the DWARF.

import { noopLogger, type Logger } from "../diagnostics/logger.js";
import { fetchBytes } from "./fetch.js";

/** Trailing path component, or "" for a directory path. LLDB searches for a
 * symbol file by basename (`SymbolLocatorDefault` builds each candidate as
 * `<search dir>/<basename>`), so any directory in the recorded path is gone by
 * the time the request reaches the provider. */
function fileName(path: string): string {
  return path.split("/").pop() ?? "";
}

export class DebugFileRegistry {
  #entries = new Map<string, Map<string, Set<AbortSignal>>>();
  #owners = new Map<
    AbortSignal,
    { entries: { name: string; url: string }[]; release: () => void }
  >();
  #reads = new Map<string, Set<AbortController>>();
  #lifetime = new AbortController();
  #logger: Logger;
  #registrationCount = 0;
  #activeReads = 0;

  constructor(logger: Logger = noopLogger) {
    this.#logger = logger;
  }

  /** Register a symbol URL for its document lifetime. Ambiguous basenames are never served. */
  register(
    recordedPath: string,
    moduleUrl: string,
    signal: AbortSignal = this.#lifetime.signal
  ): void {
    if (signal.aborted || this.#lifetime.signal.aborted) return;
    const name = fileName(recordedPath);
    if (!name) return;
    let url: string;
    try {
      url = new URL(recordedPath, moduleUrl).href;
    } catch {
      this.#logger.warn(
        `[dwarf] ${moduleUrl} names an unusable separate DWARF path ${JSON.stringify(recordedPath)}`
      );
      return;
    }
    const before = this.#uniqueUrl(name);
    if (this.#entries.get(name)?.get(url)?.has(signal)) return;
    if (this.#registrationCount >= 4096) {
      // Disabling the provider is safer than retaining a potentially ambiguous
      // earlier registration while rejecting its new competing owner.
      this.#logger.warn("[dwarf] 4096 registration limit reached; disabling symbol-file provider");
      this.close();
      return;
    }
    let urls = this.#entries.get(name);
    if (!urls) this.#entries.set(name, (urls = new Map()));
    let owners = urls.get(url);
    if (!owners) urls.set(url, (owners = new Set()));
    if (owners.has(signal)) return;
    owners.add(signal);
    this.#registrationCount++;
    let owner = this.#owners.get(signal);
    if (!owner) {
      const entries: { name: string; url: string }[] = [];
      const release = () => {
        for (const entry of entries) {
          this.#registrationCount--;
          const previous = this.#uniqueUrl(entry.name);
          const candidates = this.#entries.get(entry.name);
          const signals = candidates?.get(entry.url);
          signals?.delete(signal);
          if (signals?.size === 0) candidates?.delete(entry.url);
          if (candidates?.size === 0) this.#entries.delete(entry.name);
          this.#invalidateReads(entry.name, previous);
        }
        this.#owners.delete(signal);
        signal.removeEventListener("abort", release);
      };
      owner = { entries, release };
      this.#owners.set(signal, owner);
      signal.addEventListener("abort", release, { once: true });
    }
    owner.entries.push({ name, url });
    this.#invalidateReads(name, before);
    if (urls.size > 1)
      this.#logger.warn(
        `[dwarf] two modules name a separate DWARF file ${name}; refusing ambiguous symbols`
      );
    this.#logger.debug(`[dwarf] registered ${moduleUrl} -> ${url}`);
  }

  #uniqueUrl(name: string): string | undefined {
    const urls = this.#entries.get(name);
    return urls?.size === 1 ? urls.keys().next().value : undefined;
  }

  #invalidateReads(name: string, previous: string | undefined): void {
    if (this.#uniqueUrl(name) === previous) return;
    for (const read of this.#reads.get(name) ?? [])
      read.abort(new Error("symbol registration retired or ambiguous"));
  }

  /** Cancel pending reads and release every registration. */
  close(): void {
    this.#lifetime.abort();
    for (const owner of [...this.#owners.values()]) owner.release();
  }

  /** Serve only an unambiguous, still-owned registration; leave other paths to the provider. */
  async read(path: string): Promise<Uint8Array | null> {
    const name = fileName(path);
    const url = this.#uniqueUrl(name);
    if (!url) return null;
    if (this.#activeReads >= 4) {
      this.#logger.warn(`[dwarf] concurrent download limit reached for ${path}`);
      return null;
    }
    this.#activeReads++;
    const abort = new AbortController();
    let pending = this.#reads.get(name);
    if (!pending) this.#reads.set(name, (pending = new Set()));
    pending.add(abort);
    try {
      const bytes = await fetchBytes(url, {
        maxBytes: 64 * 1024 * 1024,
        signal: abort.signal,
        headers: { "X-Firefox-Lldb": "dwarf-fetch" },
      });
      abort.signal.throwIfAborted();
      if (this.#uniqueUrl(name) !== url) return null;
      this.#logger.debug(`[dwarf] served ${url} as ${path} (${bytes.length} bytes)`);
      return bytes;
    } catch (error) {
      this.#logger.warn(`[dwarf] could not fetch separate DWARF ${url}: ${String(error)}`);
      return null;
    } finally {
      this.#activeReads--;
      pending.delete(abort);
      if (pending.size === 0) this.#reads.delete(name);
    }
  }
}
