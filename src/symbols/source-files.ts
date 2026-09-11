/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { containedSourcePath } from "./source-path.js";
import type { Logger } from "../diagnostics/logger.js";

export function sourceBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name && name !== "." && name !== "..") return name;
  } catch {
    /* Non-URL source names use a local basename. */
  }
  const name = basename(url);
  return name && name !== "." && name !== ".." ? name : "source.js";
}

/** Owns materialized sources. A retired generation can neither read new paths
 * nor recreate its directory; close removes the per-attach root. */
export class SourceFiles {
  readonly root = mkdtempSync(join(tmpdir(), "firefox-lldb-"));
  #owners = new Map<AbortSignal, { dir: string; release: () => void }>();
  #nextGeneration = 1;
  #closed = false;
  #files = new Map<string, number>();
  #bytes = 0;

  constructor(private readonly logger: Logger) {
    process.once("exit", this.#onExit);
  }

  #onExit = (): void => {
    try {
      this.close();
    } catch (error) {
      this.logger.warn(`[source] cleanup failed for ${this.root}: ${error}`);
    }
  };

  directory(url: string, signal: AbortSignal): string {
    signal.throwIfAborted();
    if (this.#closed) throw new Error("source files closed");
    let owner = this.#owners.get(signal);
    if (!owner) {
      const dir = join(this.root, `generation-${this.#nextGeneration++}`);
      const release = () => {
        signal.removeEventListener("abort", release);
        this.#owners.delete(signal);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          this.logger.warn(`[source] generation cleanup failed for ${dir}: ${error}`);
        }
        for (const [path, size] of this.#files) {
          if (path.startsWith(dir + sep)) {
            this.#bytes -= size;
            this.#files.delete(path);
          }
        }
      };
      owner = { dir, release };
      this.#owners.set(signal, owner);
      signal.addEventListener("abort", release, { once: true });
    }
    const key = createHash("sha256").update(url).digest("hex").slice(0, 12);
    return join(owner.dir, `${sourceBasename(url)}.${key}.src`);
  }

  write(url: string, sourcePath: string, content: string | Uint8Array, signal: AbortSignal): void {
    const dest = containedSourcePath(this.directory(url, signal), sourcePath);
    if (!dest) throw new Error(`unsafe source path ${JSON.stringify(sourcePath)}`);
    const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
    const bytes = this.#bytes - (this.#files.get(dest) ?? 0) + size;
    if ((!this.#files.has(dest) && this.#files.size >= 4096) || bytes > 64 * 1024 * 1024)
      throw new Error("materialized sources exceed 4096 files or 64 MiB limit");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
    this.#files.set(dest, size);
    this.#bytes = bytes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    process.off("exit", this.#onExit);
    for (const [signal, owner] of this.#owners) signal.removeEventListener("abort", owner.release);
    this.#owners.clear();
    this.#files.clear();
    this.#bytes = 0;
    rmSync(this.root, { recursive: true, force: true });
  }
}
