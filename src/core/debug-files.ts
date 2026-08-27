/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Separate DWARF (emscripten's `-gseparate-dwarf`) lives in a companion wasm
// file the page never loads: the module only names it, in an
// `external_debug_info` custom section
// (https://yurydelendik.github.io/webassembly-dwarf/#external-DWARF).
//
// LLDB resolves that name against its own filesystem, which for the embedded
// wasm LLDB is an in-memory FS fronted by a host file provider. This registry
// is the join between the two halves: RdpDebuggee registers the URL each
// module points at, and the file provider serves it when LLDB opens that file.
// LLDB's own SymbolVendorWasm then loads the DWARF, so nothing here has to
// understand debug info.

import { noopLogger, type Logger } from "../logging.js";

/** Trailing path component, or "" for a directory path. LLDB searches for a
 * symbol file by basename (`SymbolLocatorDefault` builds each candidate as
 * `<search dir>/<basename>`), so any directory in the recorded path is gone by
 * the time the request reaches the provider. */
function fileName(path: string): string {
  return path.split("/").pop() ?? "";
}

export class DebugFileRegistry {
  #urlByName = new Map<string, string>();
  #logger: Logger;

  constructor(logger: Logger = noopLogger) {
    this.#logger = logger;
  }

  /**
   * Record that `moduleUrl` keeps its DWARF in `recordedPath`, the string from
   * its `external_debug_info` section. The path is resolved against the module
   * URL, so both a relative path and an absolute `-sSEPARATE_DWARF_URL` work.
   */
  register(recordedPath: string, moduleUrl: string): void {
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

    const previous = this.#urlByName.get(name);
    if (previous === url) return;
    if (previous) {
      // LLDB can only ask by basename, so the newer module wins and the older
      // one silently loses its symbols. Rare enough to warn about rather than
      // design around.
      this.#logger.warn(
        `[dwarf] two modules name a separate DWARF file ${name}; using ${url} instead of ${previous}`
      );
    }
    this.#urlByName.set(name, url);
    this.#logger.debug(`[dwarf] ${moduleUrl} keeps its DWARF in ${url}`);
  }

  /**
   * Serve a file LLDB opened, or null if it is not a registered debug file.
   * Wire this into `LLDBClient.setFileProvider`.
   */
  async read(path: string): Promise<Uint8Array | null> {
    const url = this.#urlByName.get(fileName(path));
    if (!url) return null;
    try {
      const response = await fetch(url, { headers: { "X-Firefox-Lldb": "dwarf-fetch" } });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.#logger.debug(`[dwarf] served ${url} as ${path} (${bytes.length} bytes)`);
      return bytes;
    } catch (err) {
      this.#logger.warn(
        `[dwarf] could not fetch separate DWARF ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }
}
