/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModuleClaim } from "./component.js";
import type { ComponentId, ModuleDescriptor } from "./types.js";

export type UnownedModuleDescriptor = Omit<ModuleDescriptor, "owner">;

export type ModuleOwnerResolver = (module: UnownedModuleDescriptor) => Promise<ComponentId>;

/** The discovery surface retained by a component catalog before (or
 * independently of) creating a target-specific component instance. */
export interface SourceDebuggerComponentProbe {
  readonly id: ComponentId;
  probeModule(module: UnownedModuleDescriptor): Promise<ModuleClaim>;
}

export interface ComponentModuleClaim {
  componentId: ComponentId;
  claim: ModuleClaim;
}

export interface ModuleProbeOptions {
  /** Deadline for each component independently. Defaults to 30 seconds. */
  timeoutMs?: number;
}

const DEFAULT_MODULE_PROBE_TIMEOUT_MS = 30_000;

/** Ask every installed component about a module. Probe failures fail closed:
 * choosing a fallback after the intended debugger failed to answer could give
 * one source engine a module whose debug information it cannot interpret. */
export async function probeModuleClaims(
  probes: readonly SourceDebuggerComponentProbe[],
  module: UnownedModuleDescriptor,
  options: ModuleProbeOptions = {}
): Promise<ComponentModuleClaim[]> {
  validateProbes(probes);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODULE_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SourceDebuggerComponent probe timeout must be a positive number");
  }
  return Promise.all(
    probes.map(async (probe) => {
      let claim: ModuleClaim;
      try {
        claim = await withTimeout(
          probe.probeModule(module),
          timeoutMs,
          `SourceDebuggerComponent ${probe.id} module probe timed out after ${timeoutMs}ms`
        );
      } catch (error) {
        throw new Error(
          `SourceDebuggerComponent ${probe.id} failed to probe Wasm module ${module.url}: ${errorMessage(error)}`,
          { cause: error }
        );
      }
      if (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 100) {
        throw new Error(
          `SourceDebuggerComponent ${probe.id} returned invalid confidence ${String(claim.confidence)} for Wasm module ${module.url}`
        );
      }
      return { componentId: probe.id, claim };
    })
  );
}

/** Build an asynchronous, deterministic one-owner resolver. The unique
 * highest-confidence supported claim wins; ties and unclaimed modules are
 * errors rather than depending on component registration order. */
export function createProbeModuleOwnerResolver(
  probes: readonly SourceDebuggerComponentProbe[],
  options: ModuleProbeOptions = {}
): ModuleOwnerResolver {
  const catalog = [...probes];
  validateProbes(catalog);
  return async (module) => {
    const claims = await probeModuleClaims(catalog, module, options);
    const supported = claims.filter(({ claim }) => claim.supported);
    if (supported.length === 0) {
      throw new Error(
        `no SourceDebuggerComponent claims Wasm module ${module.url}${formatReasons(claims)}`
      );
    }

    const confidence = Math.max(...supported.map(({ claim }) => claim.confidence));
    const winners = supported.filter(({ claim }) => claim.confidence === confidence);
    if (winners.length !== 1) {
      throw new Error(
        `Wasm module ${module.url} has ambiguous SourceDebuggerComponent claims at confidence ${confidence}: ${winners
          .map(({ componentId, claim }) =>
            claim.reason ? `${componentId} (${claim.reason})` : componentId
          )
          .join(", ")}`
      );
    }
    return winners[0].componentId;
  };
}

function validateProbes(probes: readonly SourceDebuggerComponentProbe[]): void {
  if (probes.length === 0) {
    throw new Error("module ownership discovery requires at least one SourceDebuggerComponent");
  }
  if (probes.some(({ id }) => !id)) {
    throw new Error("SourceDebuggerComponent probe ids must not be empty");
  }
  if (new Set(probes.map(({ id }) => id)).size !== probes.length) {
    throw new Error("SourceDebuggerComponent probe ids must be unique");
  }
}

function formatReasons(claims: readonly ComponentModuleClaim[]): string {
  const reasons = claims.flatMap(({ componentId, claim }) =>
    claim.reason ? [`${componentId}: ${claim.reason}`] : []
  );
  return reasons.length ? ` (${reasons.join("; ")})` : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
