/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RdpClient, RdpRequestError } from "./client.js";
import { withRdpStartupRetry } from "./startup.js";
import {
  REQUESTS,
  EVENTS,
  ROOT_ACTOR,
  type ThreadConfig,
  type TabInfo,
  type RdpTabForm,
  type ListTabsResponse,
  type GetRootResponse,
  type GetCharPrefResponse,
  type GetWatcherResponse,
  type GetThreadConfigurationActorResponse,
} from "./protocol.js";
import { noopLogger, type Logger } from "../diagnostics/logger.js";
import { requireCompatibleFirefox, type FirefoxRuntime } from "./firefox-compatibility.js";
import { LAUNCH_TOKEN_PREF } from "./constants.js";

// Thread configuration applied before navigation. observeWasm/observeAsmJS so the
// page's wasm compiles with debug support; pauseOnExceptions with
// ignoreCaughtExceptions so we break on uncaught wasm traps (surfacing as a
// stop) without pausing on routine caught JS exceptions.
export const THREAD_CONFIG: ThreadConfig = {
  observeWasm: true,
  observeAsmJS: true,
  pauseOnExceptions: true,
  ignoreCaughtExceptions: true,
};

/** Verify launch identity and compatibility on a temporary connection.
 * Retry classified connection failures; a token mismatch is terminal. */
export async function verifyFirefoxLaunchToken(
  port: number,
  host: string,
  expectedToken: string,
  attempts = 80,
  signal?: AbortSignal,
  logger?: Logger
): Promise<FirefoxRuntime> {
  return withRdpStartupRetry(
    async (attemptSignal) => {
      const client = await RdpClient.connect(port, host, { signal: attemptSignal, logger });
      try {
        const root = (await client.request(ROOT_ACTOR, {
          type: REQUESTS.getRoot,
        })) as GetRootResponse;
        const actor = root.preferenceActor;
        if (!actor) throw new Error("Firefox RDP root actor has no preferenceActor");
        const { value } = (await client.request(actor, {
          type: REQUESTS.getCharPref,
          value: LAUNCH_TOKEN_PREF,
        })) as GetCharPrefResponse;
        if (value !== expectedToken) {
          throw new Error(
            `RDP port ${port} is answering, but not from the Firefox instance this process just ` +
              `launched — a different (possibly stale) Firefox is listening there.`
          );
        }
        return await requireCompatibleFirefox(client);
      } finally {
        client.close();
      }
    },
    { signal, logger, attempts }
  );
}

/** One-shot: connect, list tabs, disconnect. */
export async function listFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  signal?: AbortSignal
): Promise<TabInfo[]> {
  const client = await RdpClient.connect(port, host, { signal });
  try {
    const { tabs } = (await client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse;
    return toTabInfos(tabs);
  } finally {
    client.close();
  }
}

function toTabInfos(tabs: RdpTabForm[] | undefined): TabInfo[] {
  return (tabs ?? []).map((tab) => ({
    id: browserId(tab),
    url: tab.url ?? "",
    title: tab.title ?? "",
  }));
}

export function browserId(tab: RdpTabForm): number {
  if (!Number.isSafeInteger(tab.browserId) || tab.browserId! <= 0)
    throw new Error(`Firefox tab ${tab.actor} has no stable browserId`);
  return tab.browserId!;
}

export class MissingTabError extends Error {
  constructor(id: number) {
    super(`Firefox tab ${id} is no longer available`);
    this.name = "MissingTabError";
  }
}

/**
 * Watch the tab list and enable observeWasm:true on each tab via a persistent
 * watcher. The thread config survives page navigation: any page
 * loaded in a primed tab after this call compiles wasm in debug mode, making
 * breakpoints available without a reload. Resolves when the connection closes.
 */
export async function watchAndPrimeFirefoxTabs(
  port = 6080,
  host = "127.0.0.1",
  onTabs: (tabs: TabInfo[]) => void,
  logger: Logger = noopLogger,
  signal?: AbortSignal
): Promise<void> {
  const client = await RdpClient.connect(port, host, { logger, signal });
  let closed = false;
  let failure: unknown;
  // Subscribe before compatibility checks or queries can observe a close.
  const closing = new Promise<void>((resolve) =>
    client.once("close", () => {
      closed = true;
      resolve();
    })
  );
  client.on("error", (error: Error) => {
    failure ??= error;
  });
  const primedActors = new Set<string>();

  const primeTab = async (tabActor: string) => {
    if (primedActors.has(tabActor)) return;
    try {
      const watcherR = (await client.request(tabActor, {
        type: REQUESTS.getWatcher,
        isServerTargetSwitchingEnabled: true,
      })) as GetWatcherResponse;
      const watcher = watcherR.actor;
      if (!watcher) throw new Error("no watcher actor");
      const cfg = (await client.request(watcher, {
        type: REQUESTS.getThreadConfigurationActor,
      })) as GetThreadConfigurationActorResponse;
      const configActor =
        typeof cfg.configuration === "string" ? cfg.configuration : cfg.configuration?.actor;
      if (!configActor) throw new Error("no thread config actor");
      await client.request(configActor, {
        type: REQUESTS.updateConfiguration,
        configuration: THREAD_CONFIG,
      });
      primedActors.add(tabActor);
      logger.debug(`[rdp] tab primed actor=${tabActor}`);
      // Only the per-tab debugger may watchTargets: a competing subscriber
      // can steal its pause events and strand EventFuture.finish.
    } catch (err) {
      if (closed || signal?.aborted) return;
      if (!(err instanceof RdpRequestError && err.code === "noSuchActor")) throw err;
      logger.debug(`[rdp] tab retired while priming actor=${tabActor}`);
    }
  };

  const query = async () => {
    const { tabs } = (await client.request(ROOT_ACTOR, {
      type: REQUESTS.listTabs,
    })) as ListTabsResponse;
    const tabList = tabs ?? [];
    if (closed || signal?.aborted) return;
    const live = new Set(tabList.map((tab) => tab.actor));
    for (const actor of primedActors) if (!live.has(actor)) primedActors.delete(actor);
    onTabs(toTabInfos(tabList));
    for (const tab of tabList) {
      if (closed || signal?.aborted) return;
      await primeTab(tab.actor);
    }
  };
  let dirty = true;
  let enabled = false;
  let refresh: Promise<void> | undefined;
  const schedule = () => {
    dirty = true;
    if (!enabled || refresh || closed || failure) return;
    refresh = (async () => {
      while (dirty && !closed) {
        dirty = false;
        await query();
      }
    })()
      .catch((error: unknown) => {
        if (!closed && !signal?.aborted) failure ??= error;
        client.close();
      })
      .finally(() => {
        refresh = undefined;
        if (dirty && !closed && !failure) schedule();
      });
  };
  client.on("event", (packet) => {
    if (packet.type === EVENTS.tabListChanged || packet.type === EVENTS.tabNavigated) schedule();
  });

  let startupRetry: ReturnType<typeof setTimeout> | undefined;
  try {
    await requireCompatibleFirefox(client, logger);
    enabled = true;
    schedule();
    startupRetry = setTimeout(schedule, 2000);
    await closing;
    await refresh;
    if (failure && !signal?.aborted) throw failure;
  } finally {
    clearTimeout(startupRetry);
    client.close();
    await refresh;
    primedActors.clear();
  }
}
