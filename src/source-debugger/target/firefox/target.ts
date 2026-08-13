/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { noopLogger, type Logger } from "../../../logging.js";
import { RdpDebuggee } from "./rdp-debuggee.js";
import {
  focusFirefoxWindow,
  launchFirefox,
  type FirefoxChannel,
  type FirefoxHandle,
} from "./rdp/firefox.js";
import { RdpWasmSession, verifyFirefoxLaunchToken } from "./rdp/session.js";
import type { SourceDebuggerTarget, UnownedModuleDescriptor } from "../../protocol/target.js";
import type { WasmDebuggee } from "../../protocol/wasm-debuggee.js";
import { FirefoxWasmDebuggee } from "./wasm-debuggee.js";

export interface FirefoxSourceDebuggerTargetOptions {
  connect: boolean;
  headless: boolean;
  rdpPort: number;
  marionettePort?: number;
  url?: string;
  firefox?: string;
  channel: FirefoxChannel;
  defaultProfile: boolean;
  fire?: string;
  logger?: Logger;
  onOutput?: (message: string) => void;
  onConsole?: (message: string) => void;
  onFirefoxExit?: () => void;
}

/** Browser-owned physical target. It exists before any language debugger,
 * provides normalized module metadata for catalog discovery, and lends each
 * selected component a filtered WasmDebuggee view over the shared RDP stop. */
export class FirefoxSourceDebuggerTarget implements SourceDebuggerTarget {
  readonly session: RdpWasmSession;
  readonly #options: FirefoxSourceDebuggerTargetOptions;
  readonly #logger: Logger;
  readonly #firefox: FirefoxHandle | undefined;
  readonly #onOutput: (message: string) => void;
  readonly #onConsole: (message: string) => void;
  readonly #onFirefoxExit: () => void;
  readonly #detachListeners = new Set<() => void>();
  readonly #wasmDebuggees = new Set<FirefoxWasmDebuggee>();
  readonly #moduleOwnerByUrl = new Map<string, string>();
  #firstContinueFired = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    session: RdpWasmSession,
    firefox: FirefoxHandle | undefined,
    options: FirefoxSourceDebuggerTargetOptions
  ) {
    this.session = session;
    this.#firefox = firefox;
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
    this.#onOutput = options.onOutput ?? (() => {});
    this.#onConsole = options.onConsole ?? (() => {});
    this.#onFirefoxExit = options.onFirefoxExit ?? (() => {});
    this.#installSessionEvents();
  }

  get automaticAttach(): boolean {
    return this.#options.url !== undefined;
  }

  static async start(
    options: FirefoxSourceDebuggerTargetOptions
  ): Promise<FirefoxSourceDebuggerTarget> {
    const logger = options.logger ?? noopLogger;
    let firefox: FirefoxHandle | undefined;
    let session: RdpWasmSession | undefined;
    try {
      if (!options.connect) {
        firefox = await launchFirefox({
          rdpPort: options.rdpPort,
          binary: options.firefox,
          channel: options.channel,
          defaultProfile: options.defaultProfile,
          headless: options.headless,
          marionettePort: options.marionettePort,
        });
        await verifyFirefoxLaunchToken(options.rdpPort, "127.0.0.1", firefox.launchToken);
        logger.info("launched Firefox");
      }

      session = await connectRdpWithRetry(options.rdpPort, logger);
      const target = new FirefoxSourceDebuggerTarget(session, firefox, options);
      if (options.url) {
        await session.navigate(options.url);
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

  assignModuleOwner(moduleId: string, componentId: string): void {
    this.#moduleOwnerByUrl.set(moduleId, componentId);
  }

  removeModuleOwner(moduleId: string): void {
    this.#moduleOwnerByUrl.delete(moduleId);
  }

  moduleOwner(moduleId: string): string | undefined {
    return this.#moduleOwnerByUrl.get(moduleId);
  }

  async openWasmDebuggee(componentId: string): Promise<WasmDebuggee> {
    if (this.#closePromise) throw new Error("FirefoxSourceDebuggerTarget is closed");
    const debuggee = await FirefoxWasmDebuggee.create(
      this.session,
      (moduleId) => this.#moduleOwnerByUrl.get(moduleId) === componentId,
      {
        logger: this.#logger,
        onFirstContinue: () => this.#onFirstContinue(),
      }
    );
    if (this.#closePromise) {
      await debuggee.dispose();
      throw new Error("FirefoxSourceDebuggerTarget closed while opening a Wasm debuggee");
    }
    this.#wasmDebuggees.add(debuggee);
    return debuggee;
  }

  onDetached(listener: () => void): () => void {
    this.#detachListeners.add(listener);
    return () => this.#detachListeners.delete(listener);
  }

  focus(): void {
    if (this.#firefox?.pid !== undefined) focusFirefoxWindow(this.#firefox.pid);
  }

  interrupt(): void {
    for (const debuggee of this.#wasmDebuggees) debuggee.triggerInterrupt();
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
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
      for (const listener of this.#detachListeners) listener();
    });
    void this.#firefox?.exited.then(() => {
      if (!this.#closePromise) this.#onFirefoxExit();
    });
  }

  #onFirstContinue(): void {
    if (this.#firstContinueFired) return;
    this.#firstContinueFired = true;
    const fire = this.#options.fire;
    if (!fire) return;
    const wrapped = `(function poll(){try{${fire}}catch(e){setTimeout(poll,20);}})()`;
    void this.session
      .evaluate(wrapped)
      .catch((error) =>
        this.#logger.debug(
          `[rdp] --fire evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    this.#detachListeners.clear();
    this.#moduleOwnerByUrl.clear();
    await Promise.allSettled([...this.#wasmDebuggees].map((debuggee) => debuggee.dispose()));
    this.#wasmDebuggees.clear();
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
