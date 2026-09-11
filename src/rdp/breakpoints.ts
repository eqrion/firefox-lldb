/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RdpClient } from "./client.js";
import { REQUESTS, type GetBreakpointPositionsResponse, type SourceForm } from "./protocol.js";
import type { Logger } from "../diagnostics/logger.js";
import type { WasmFunctionRange } from "../symbols/wasm-bytecode.js";

type Kind = "wasm" | "js";
export interface BreakpointLocation {
  sourceUrl: string;
  line: number;
  column?: number;
}
interface Desired {
  kind: Kind;
  url: string;
  line: number;
  range?: WasmFunctionRange;
}
interface Target {
  actor: string;
  generation: number;
  sources: Map<string, SourceForm>;
  applied: Map<string, BreakpointLocation>;
  revision: number;
  work?: Promise<void>;
}

const key = (kind: Kind, url: string, line: number) => JSON.stringify([kind, url, line]);
const sourceKey = (kind: Kind, url: string) => JSON.stringify([kind, url]);
const siteKey = (location: BreakpointLocation) => JSON.stringify(location);

/** Own desired locations and serialize their physical installation per thread actor. */
export class RdpBreakpoints {
  #client: RdpClient;
  #logger: Logger;
  #desired = new Map<string, Desired>();
  #targets = new Map<string, Target>();
  #positions = new Map<string, Promise<Record<string, number[]>>>();
  #revision = 0;
  #closed = false;

  constructor(client: RdpClient, logger: Logger) {
    this.#client = client;
    this.#logger = logger;
  }

  async addTarget(actor: string, generation: number): Promise<void> {
    if (this.#closed) return;
    let target = this.#targets.get(actor);
    if (target) {
      target.generation = generation;
      target.revision++;
    } else {
      target = { actor, generation, sources: new Map(), applied: new Map(), revision: 0 };
      this.#targets.set(actor, target);
    }
    await this.#reconcile(target);
  }

  removeTarget(actor: string): void {
    const target = this.#targets.get(actor);
    this.#targets.delete(actor);
    for (const source of target?.sources.values() ?? []) this.#positions.delete(source.actor);
  }

  close(): void {
    this.#closed = true;
    this.#targets.clear();
    this.#desired.clear();
    this.#positions.clear();
  }

  /** Source events drive replay; no polling or abandoned actor requests are needed. */
  async sources(actor: string, sources: SourceForm[]): Promise<void> {
    const target = this.#targets.get(actor);
    if (!target || this.#closed) return;
    let changed = false;
    for (const source of sources) {
      if (!source.url) continue;
      const id = sourceKey(source.introductionType === "wasm" ? "wasm" : "js", source.url);
      if (target.sources.get(id)?.actor === source.actor) continue;
      if (!target.sources.has(id) && target.sources.size >= 16384)
        throw new Error("breakpoint source limit exceeded (16384 per target)");
      const previous = target.sources.get(id);
      if (previous) this.#positions.delete(previous.actor);
      target.sources.set(id, source);
      changed = true;
    }
    if (!changed) return;
    target.revision++;
    this.#revision++;
    await this.#reconcileAll();
  }

  async set(
    kind: Kind,
    url: string,
    line: number,
    range?: WasmFunctionRange
  ): Promise<BreakpointLocation> {
    if (this.#closed) throw new Error("breakpoint owner closed");
    const id = key(kind, url, line);
    if (!this.#desired.has(id) && this.#desired.size >= 4096)
      throw new Error("desired breakpoint limit exceeded (4096)");
    const desired = { kind, url, line, range };
    this.#desired.set(id, desired);
    this.#revision++;
    try {
      await this.#reconcileAll();
    } catch (error) {
      if (this.#desired.get(id) === desired) {
        this.#desired.delete(id);
        this.#revision++;
        try {
          await this.#reconcileAll();
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            "breakpoint installation and rollback failed"
          );
        }
      }
      throw error;
    }
    if (this.#desired.get(id) !== desired) throw new Error("breakpoint request superseded");
    for (const target of this.#targets.values()) {
      const source = this.#source(target, kind, url);
      if (!source) continue;
      const location = await this.#snap(desired, source);
      if (this.#desired.get(id) !== desired) throw new Error("breakpoint request superseded");
      if (this.#targets.get(target.actor) === target && target.applied.has(siteKey(location)))
        return location;
    }
    // Unloaded sources remain desired, and are reconciled when Firefox announces them.
    this.#logger.debug(`[breakpoints] deferred ${id}`);
    return { sourceUrl: url, line, ...(kind === "wasm" ? { column: 1 } : {}) };
  }

  async remove(kind: Kind, url: string, line: number): Promise<void> {
    this.#desired.delete(key(kind, url, line));
    this.#revision++;
    await this.#reconcileAll();
  }

  async #reconcileAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#targets.values()].map((target) => this.#reconcile(target))
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "breakpoint reconciliation failed"
      );
  }

  #source(target: Target, kind: Kind, url: string): SourceForm | undefined {
    const id = sourceKey(kind, url);
    const own = target.sources.get(id);
    if (own) return own;
    // A pool worker can execute immediately after instantiation. Register the
    // URL breakpoint before its source event, using positions from a peer in
    // this same document generation. Never borrow positions across navigation.
    for (const peer of this.#targets.values()) {
      if (peer.generation !== target.generation) continue;
      const source = peer.sources.get(id);
      if (source) return source;
    }
  }

  #reconcile(target: Target): Promise<void> {
    // Queue behind the previous owner even if it is between its last revision
    // check and settlement. Each drain sees the latest desired state, so bursts
    // coalesce without losing an update in that settlement gap.
    const work = (target.work?.catch(() => {}) ?? Promise.resolve())
      .then(async () => {
        while (!this.#closed && this.#targets.get(target.actor) === target) {
          const revision = this.#revision;
          const sourceRevision = target.revision;
          const wanted = new Map<string, BreakpointLocation>();
          for (const [id, desired] of this.#desired) {
            const source = this.#source(target, desired.kind, desired.url);
            if (!source) continue;
            const location = await this.#snap(desired, source);
            if (this.#targets.get(target.actor) !== target) return;
            if (this.#desired.get(id) !== desired || target.revision !== sourceRevision) continue;
            // Multiple logical requests can share this site. It is removed only
            // when no desired request resolves to it in the current revision.
            wanted.set(siteKey(location), location);
          }
          if (revision !== this.#revision || sourceRevision !== target.revision) continue;
          for (const [site, location] of target.applied) {
            if (wanted.has(site)) continue;
            await this.#client.request(target.actor, { type: REQUESTS.removeBreakpoint, location });
            if (this.#targets.get(target.actor) !== target) return;
            target.applied.delete(site);
            this.#logger.debug(`[breakpoints] removed actor=${target.actor} site=${site}`);
          }
          for (const [site, location] of wanted) {
            if (revision !== this.#revision || sourceRevision !== target.revision) break;
            if (target.applied.has(site)) continue;
            await this.#client.request(target.actor, {
              type: REQUESTS.setBreakpoint,
              location,
              options: {},
            });
            if (this.#targets.get(target.actor) !== target) return;
            target.applied.set(site, location);
            this.#logger.debug(`[breakpoints] applied actor=${target.actor} site=${site}`);
          }
          if (revision === this.#revision && sourceRevision === target.revision) return;
        }
      })
      .catch((error) => {
        if (!this.#closed && this.#targets.get(target.actor) === target) throw error;
      })
      .finally(() => {
        if (target.work === work) target.work = undefined;
      });
    target.work = work;
    return work;
  }

  async positions(actor: string): Promise<Record<string, number[]>> {
    let pending = this.#positions.get(actor);
    if (!pending) {
      pending = this.#client
        .request(actor, {
          type: REQUESTS.getBreakpointPositionsCompressed,
          query: { start: { line: 0 }, end: { line: 1e7 } },
        })
        .then((response) => {
          const positions = (response as GetBreakpointPositionsResponse).positions;
          if (!positions) throw new Error(`missing breakpoint positions from ${actor}`);
          return positions;
        });
      this.#positions.set(actor, pending);
      void pending.catch(() => {
        if (this.#positions.get(actor) === pending) this.#positions.delete(actor);
      });
    }
    return pending;
  }

  async #snap(desired: Desired, source: SourceForm): Promise<BreakpointLocation> {
    const positions = await this.positions(source.actor);
    const lines = Object.keys(positions)
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    let line = desired.line;
    if (desired.kind === "wasm") {
      const candidates = desired.range
        ? lines.filter(
            (position) => position >= desired.range!.start && position < desired.range!.end
          )
        : lines;
      if (!candidates.length) throw new Error(`no legal wasm breakpoint at ${desired.url}:${line}`);
      line = candidates.reduce((best, position) =>
        Math.abs(position - line) < Math.abs(best - line) ? position : best
      );
      return { sourceUrl: desired.url, line, column: 1 };
    }
    const executable = lines.filter((position) => positions[String(position)]?.length);
    if (!executable.length) throw new Error(`no legal JS breakpoint at ${desired.url}:${line}`);
    line = executable.find((position) => position >= line) ?? executable.at(-1)!;
    const column = positions[String(line)]?.slice().sort((a, b) => a - b)[0];
    return { sourceUrl: desired.url, line, ...(column === undefined ? {} : { column }) };
  }
}
