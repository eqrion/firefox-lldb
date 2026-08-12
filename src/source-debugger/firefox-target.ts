/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Args, PlatformServerHandle } from "../core/platform-session.js";
import { startPlatformServer } from "../core/platform-session.js";
import { RdpDebuggee, type RdpDebuggeeRunControl } from "../gdb/rdp-debuggee.js";
import { noopLogger, type Logger } from "../logging.js";
import { focusFirefoxWindow, launchFirefox, type FirefoxHandle } from "../rdp/firefox.js";
import { RdpWasmSession, verifyFirefoxLaunchToken } from "../rdp/session.js";
import type { UnownedModuleDescriptor } from "./ownership.js";

export interface FirefoxSourceDebuggerTargetOptions {
  args: Args;
  logger?: Logger;
  onOutput?: (message: string) => void;
  onConsole?: (message: string) => void;
  onFirefoxExit?: () => void;
}

export interface FirefoxGdbRspProjectionOptions {
  componentId: string;
  primary: boolean;
  wrapConnectPort: (port: number) => Promise<number>;
  runControl?: RdpDebuggeeRunControl;
  moduleFilter?: (url: string, kind: "wasm" | "javascript") => boolean;
}

export interface FirefoxGdbRspProjection {
  readonly port: number;
  close(): Promise<void>;
}

/** Browser-owned physical target. It exists before any language debugger,
 * provides normalized module metadata for catalog discovery, and lends each
 * selected component a filtered GDB RSP projection over the shared RDP stop. */
export class FirefoxSourceDebuggerTarget {
  readonly session: RdpWasmSession;
  readonly #args: Args;
  readonly #logger: Logger;
  readonly #firefox: FirefoxHandle | undefined;
  readonly #onOutput: (message: string) => void;
  readonly #onConsole: (message: string) => void;
  readonly #onFirefoxExit: () => void;
  readonly #detachListeners = new Set<() => void>();
  readonly #projections = new Set<FirefoxGdbRspProjection>();
  #interrupt: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    session: RdpWasmSession,
    firefox: FirefoxHandle | undefined,
    options: FirefoxSourceDebuggerTargetOptions
  ) {
    this.session = session;
    this.#firefox = firefox;
    this.#args = options.args;
    this.#logger = options.logger ?? noopLogger;
    this.#onOutput = options.onOutput ?? (() => {});
    this.#onConsole = options.onConsole ?? (() => {});
    this.#onFirefoxExit = options.onFirefoxExit ?? (() => {});
    this.#installSessionEvents();
  }

  get automaticAttach(): boolean {
    return this.#args.url !== undefined;
  }

  static async start(
    options: FirefoxSourceDebuggerTargetOptions
  ): Promise<FirefoxSourceDebuggerTarget> {
    const logger = options.logger ?? noopLogger;
    let firefox: FirefoxHandle | undefined;
    let session: RdpWasmSession | undefined;
    try {
      if (!options.args.connect) {
        firefox = await launchFirefox({
          rdpPort: options.args.rdpPort,
          binary: options.args.firefox,
          channel: options.args.channel,
          defaultProfile: options.args.defaultProfile,
          headless: options.args.headless,
          marionettePort: options.args.marionettePort,
        });
        await verifyFirefoxLaunchToken(options.args.rdpPort, "127.0.0.1", firefox.launchToken);
        logger.info("launched Firefox");
      }

      session = await connectRdpWithRetry(options.args.rdpPort, logger);
      const target = new FirefoxSourceDebuggerTarget(session, firefox, options);
      if (options.args.url) {
        await session.navigate(options.args.url);
        await waitForInitialWasm(session, logger);
      }

      // Discovery and every later debugger projection must observe one shared,
      // real all-stop. Prime it without creating a language debugger engine.
      const primer = new RdpDebuggee(session, { logger });
      try {
        await primer.primeStop();
      } finally {
        primer.dispose();
      }
      return target;
    } catch (error) {
      session?.close();
      await firefox?.close().catch(() => {});
      throw error;
    }
  }

  async modules(): Promise<UnownedModuleDescriptor[]> {
    const sources = await this.session.wasmSources();
    return Promise.all(
      sources.map(async (source) => {
        const debugInfo = await this.session.wasmModuleDebugInfo(source.url);
        return {
          id: source.url,
          url: source.url,
          ...(debugInfo.length ? { debugInfo } : {}),
        };
      })
    );
  }

  async createGdbRspProjection(
    options: FirefoxGdbRspProjectionOptions
  ): Promise<FirefoxGdbRspProjection> {
    if (this.#closePromise) throw new Error("FirefoxSourceDebuggerTarget is closed");
    const handle = await startPlatformServer(
      {
        ...this.#args,
        connect: true,
        port: options.primary ? this.#args.port : 0,
        url: undefined,
        fire: options.primary ? this.#args.fire : undefined,
      },
      {
        wrapConnectPort: options.wrapConnectPort,
        sharedRdpSession: this.session,
        primeSharedSession: options.primary,
        runControl: options.runControl,
        moduleFilter: options.moduleFilter,
        logger: this.#logger,
        onTab: (tab, pid) => this.#onOutput(`tab available: ${tab.url}\n  attach --pid ${pid}`),
        onSession: (_session, interrupt) => {
          if (options.primary) this.#interrupt = interrupt;
        },
      }
    );
    const projection = this.#projection(handle, options.primary);
    this.#projections.add(projection);
    return projection;
  }

  onDetached(listener: () => void): () => void {
    this.#detachListeners.add(listener);
    return () => this.#detachListeners.delete(listener);
  }

  focus(): void {
    if (this.#firefox?.pid !== undefined) focusFirefoxWindow(this.#firefox.pid);
  }

  interrupt(): void {
    this.#interrupt?.();
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  #projection(handle: PlatformServerHandle, primary: boolean): FirefoxGdbRspProjection {
    let closePromise: Promise<void> | undefined;
    const projection: FirefoxGdbRspProjection = {
      port: handle.port,
      close: () =>
        (closePromise ??= (async () => {
          this.#projections.delete(projection);
          try {
            await handle.shutdown();
          } finally {
            if (primary) this.#interrupt = undefined;
          }
        })()),
    };
    return projection;
  }

  #installSessionEvents(): void {
    void this.session.streamConsole((message) => this.#onConsole(message));
    let awaitingNavigationTarget = false;
    this.session.on("navigated", () => {
      this.#onOutput("page navigating; re-syncing debug session...");
      awaitingNavigationTarget = true;
    });
    this.session.on("target", (info) => {
      if (!info.isTopLevel || !awaitingNavigationTarget) return;
      awaitingNavigationTarget = false;
      this.#onOutput(`page navigated to ${info.url}`);
    });
    this.session.on("detached", () => {
      this.#onOutput("the attached tab was closed; detaching.");
      this.#interrupt = undefined;
      for (const listener of this.#detachListeners) listener();
    });
    void this.#firefox?.exited.then(() => {
      if (!this.#closePromise) this.#onFirefoxExit();
    });
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    for (const projection of [...this.#projections].reverse()) {
      try {
        await projection.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#detachListeners.clear();
    this.session.close();
    try {
      await this.#firefox?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Firefox debugger target cleanup failed");
  }
}

async function connectRdpWithRetry(port: number, logger: Logger): Promise<RdpWasmSession> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return await RdpWasmSession.start(port, "127.0.0.1", undefined, logger);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `could not connect to Firefox RDP on ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function waitForInitialWasm(session: RdpWasmSession, logger: Logger): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await session.wasmSources()).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  logger.debug(
    "[source-debugger] no Wasm module appeared before catalog discovery; using configured fallbacks"
  );
}
