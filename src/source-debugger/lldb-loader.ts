/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Args, PlatformServerHandle } from "../core/platform-session.js";
import { startPlatformServer } from "../core/platform-session.js";
import { noopLogger, type Logger } from "../logging.js";
import { focusFirefoxWindow } from "../rdp/firefox.js";
import type { RdpWasmSession } from "../rdp/session.js";
import type {
  ModuleClaim,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "./component.js";
import { componentForModuleUrl, type SourceDebuggerComponentRoute } from "./config.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import {
  IsolatedLldbComponentRuntime,
  type IsolatedLldbComponentRuntimeOptions,
} from "./lldb-isolate.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentActivation,
  SourceDebuggerComponentLoader,
} from "./loader.js";
import type { ModuleDescriptor } from "./types.js";

export interface LldbSourceDebuggerTargetOptions {
  args: Args;
  routes: readonly SourceDebuggerComponentRoute[];
  logger?: Logger;
  /** Status and lifecycle text for the frontend. */
  onOutput?: (message: string) => void;
  onConsole?: (message: string) => void;
  onFirefoxExit?: () => void;
}

interface LldbTargetActivation extends SourceDebuggerComponentActivation {
  close(): Promise<void>;
}

/** Firefox target integration used by the installed LLDB ecosystem. It owns
 * every LLDB-specific platform/RSP/attach detail; neither the generic session
 * runtime nor its frontend needs to know how LLDB reaches the debuggee. */
export class LldbSourceDebuggerTarget {
  readonly #args: Args;
  readonly #routes: readonly SourceDebuggerComponentRoute[];
  readonly #logger: Logger;
  readonly #onOutput: (message: string) => void;
  readonly #onConsole: (message: string) => void;
  readonly #onFirefoxExit: () => void;
  readonly #activeRuntimes = new Map<string, IsolatedLldbComponentRuntime>();
  #primaryId: string | undefined;
  #primarySession: RdpWasmSession | undefined;
  #interrupt: (() => void) | undefined;
  #firefoxPid: number | undefined;

  constructor(options: LldbSourceDebuggerTargetOptions) {
    this.#args = options.args;
    this.#routes = options.routes;
    this.#logger = options.logger ?? noopLogger;
    this.#onOutput = options.onOutput ?? (() => {});
    this.#onConsole = options.onConsole ?? (() => {});
    this.#onFirefoxExit = options.onFirefoxExit ?? (() => {});
  }

  get rdpSession(): RdpWasmSession | undefined {
    return this.#primarySession;
  }

  focus(): void {
    if (this.#firefoxPid !== undefined) focusFirefoxWindow(this.#firefoxPid);
  }

  interrupt(): void {
    this.#interrupt?.();
  }

  async activate(
    runtime: IsolatedLldbComponentRuntime,
    route: SourceDebuggerComponentRoute
  ): Promise<LldbTargetActivation> {
    if (this.#activeRuntimes.has(runtime.id)) {
      throw new Error(`SourceDebuggerComponent ${runtime.id} is already active`);
    }
    return this.#primaryId === undefined
      ? this.#activatePrimary(runtime, route)
      : this.#activateSecondary(runtime, route);
  }

  async #activatePrimary(
    runtime: IsolatedLldbComponentRuntime,
    route: SourceDebuggerComponentRoute
  ): Promise<LldbTargetActivation> {
    const routedComponents = this.#args.components.length > 0;
    let handle: PlatformServerHandle | undefined;
    // Navigation can detach the RDP target while LLDB's initial attach is
    // still pending. Treat the runtime as participating before attach so the
    // detach handler resets it and the next attach attempt starts cleanly.
    this.#activeRuntimes.set(runtime.id, runtime);
    try {
      handle = await startPlatformServer(this.#args, {
        wrapConnectPort: runtime.bridgeTcp,
        runControl: runtime.runControl,
        ...(routedComponents
          ? {
              moduleFilter: (url: string, kind: "wasm" | "javascript") =>
                kind === "wasm" && componentForModuleUrl(this.#routes, url).id === route.id,
            }
          : {}),
        logger: this.#logger,
        onTab: (tab, pid) => this.#onOutput(`tab available: ${tab.url}\n  attach --pid ${pid}`),
        onSession: (session, interrupt) => this.#installPrimarySession(session, interrupt),
      });
      this.#primaryId = runtime.id;
      this.#firefoxPid = handle.firefoxPid;

      await runtime.connectPlatform(handle.port);
      await runtime.command("command alias attach process attach --plugin wasm");

      const greeting =
        "firefox-lldb source debugger — `attach --pid N` to attach, `help` for generic commands.";
      let readyMessage: string;
      if (this.#args.url) {
        this.#onOutput(`${greeting}\nattaching...`);
        readyMessage = await runtime.attach(1, {
          onRetry: (attempt) =>
            this.#onOutput(`automatic attach attempt ${attempt} was interrupted; retrying...`),
        });
        if (this.#routes.length > 1 && !this.#primarySession) {
          throw new Error("primary component attached without publishing its RDP session");
        }
      } else {
        const result = await runtime.command("platform process list");
        readyMessage = `${greeting}\n${result.output.trimEnd()}`;
      }

      const activeHandle = handle;
      void activeHandle.firefoxExited?.then(() => {
        if (this.#activeRuntimes.has(runtime.id)) this.#onFirefoxExit();
      });
      return this.#activationHandle(runtime.id, activeHandle, readyMessage, true);
    } catch (error) {
      this.#activeRuntimes.delete(runtime.id);
      if (this.#primaryId === runtime.id) this.#clearPrimary(runtime.id);
      await handle
        ?.shutdown()
        .catch((cleanupError) =>
          this.#logger.error(
            `failed to roll back primary debugger target: ${errorMessage(cleanupError)}`
          )
        );
      throw error;
    }
  }

  async #activateSecondary(
    runtime: IsolatedLldbComponentRuntime,
    route: SourceDebuggerComponentRoute
  ): Promise<LldbTargetActivation> {
    if (!this.#primarySession) {
      throw new Error(`cannot activate ${runtime.id} before the primary debuggee session exists`);
    }
    let handle: PlatformServerHandle | undefined;
    this.#activeRuntimes.set(runtime.id, runtime);
    try {
      this.#onOutput(`attaching ${route.id}...`);
      handle = await startPlatformServer(
        {
          ...this.#args,
          connect: true,
          port: 0,
          url: undefined,
          fire: undefined,
        },
        {
          wrapConnectPort: runtime.bridgeTcp,
          sharedRdpSession: this.#primarySession,
          runControl: runtime.runControl,
          moduleFilter: (url, kind) =>
            kind === "wasm" && componentForModuleUrl(this.#routes, url).id === route.id,
          logger: this.#logger,
        }
      );
      await runtime.connectPlatform(handle.port);
      await runtime.command("command alias attach process attach --plugin wasm");
      // Let the connect-mode tab watcher populate its stable PID map before
      // the attach handshake asks it to launch the per-tab RSP server.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await runtime.command("platform process list");
      await runtime.attach(1, {
        onRetry: (attempt) =>
          this.#onOutput(`${route.id} attach attempt ${attempt} was interrupted; retrying...`),
      });
      return this.#activationHandle(runtime.id, handle, undefined, false);
    } catch (error) {
      this.#activeRuntimes.delete(runtime.id);
      await handle
        ?.shutdown()
        .catch((cleanupError) =>
          this.#logger.error(
            `failed to roll back debugger target ${runtime.id}: ${errorMessage(cleanupError)}`
          )
        );
      throw error;
    }
  }

  #activationHandle(
    componentId: string,
    handle: PlatformServerHandle,
    readyMessage: string | undefined,
    primary: boolean
  ): LldbTargetActivation {
    let closePromise: Promise<void> | undefined;
    return {
      ...(readyMessage === undefined ? {} : { readyMessage }),
      close: () =>
        (closePromise ??= (async () => {
          this.#activeRuntimes.delete(componentId);
          try {
            await handle.shutdown();
          } finally {
            if (primary) this.#clearPrimary(componentId);
          }
        })()),
    };
  }

  #installPrimarySession(session: RdpWasmSession, interrupt: () => void): void {
    this.#primarySession = session;
    this.#interrupt = interrupt;
    void session.streamConsole((message) => this.#onConsole(message));

    let awaitingNavigationTarget = false;
    session.on("navigated", () => {
      this.#onOutput("page navigating; re-syncing debug session...");
      awaitingNavigationTarget = true;
    });
    session.on("target", (info) => {
      if (!info.isTopLevel || !awaitingNavigationTarget) return;
      awaitingNavigationTarget = false;
      this.#onOutput(`page navigated to ${info.url}`);
    });
    session.on("detached", () => {
      this.#onOutput("the attached tab was closed; detaching.");
      if (this.#primarySession === session) {
        this.#primarySession = undefined;
        this.#interrupt = undefined;
      }
      for (const runtime of this.#activeRuntimes.values()) {
        void runtime
          .command("process detach")
          .catch((error) =>
            this.#logger.debug(`[cleanup] LLDB detach failed: ${errorMessage(error)}`)
          );
      }
    });
  }

  #clearPrimary(componentId: string): void {
    if (this.#primaryId !== componentId) return;
    this.#primaryId = undefined;
    this.#primarySession = undefined;
    this.#interrupt = undefined;
    this.#firefoxPid = undefined;
  }
}

export type LldbSourceDebuggerComponentLoaderOptions = Omit<
  IsolatedLldbComponentRuntimeOptions,
  "host" | "id"
>;

/** Installed LLDB ecosystem entry for the generic component catalog. */
export class LldbSourceDebuggerComponentLoader implements SourceDebuggerComponentLoader {
  readonly id: string;

  constructor(
    private readonly target: LldbSourceDebuggerTarget,
    private readonly route: SourceDebuggerComponentRoute,
    private readonly options: LldbSourceDebuggerComponentLoaderOptions = {}
  ) {
    this.id = route.id;
  }

  async load(host: SourceDebuggerComponentHostBinding): Promise<LoadedSourceDebuggerComponent> {
    const runtime = await IsolatedLldbComponentRuntime.create({
      ...this.options,
      id: this.id,
      host,
    });
    return new LoadedLldbSourceDebuggerComponent(runtime, this.target, this.route);
  }
}

class LoadedLldbSourceDebuggerComponent implements LoadedSourceDebuggerComponent {
  readonly #runtime: IsolatedLldbComponentRuntime;
  readonly #target: LldbSourceDebuggerTarget;
  readonly #route: SourceDebuggerComponentRoute;
  #activation: LldbTargetActivation | undefined;
  #activationPromise: Promise<SourceDebuggerComponentActivation> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    runtime: IsolatedLldbComponentRuntime,
    target: LldbSourceDebuggerTarget,
    route: SourceDebuggerComponentRoute
  ) {
    this.#runtime = runtime;
    this.#target = target;
    this.#route = route;
  }

  get id(): string {
    return this.#runtime.id;
  }

  get definition(): SourceDebuggerComponentDefinition {
    return this.#runtime.definition;
  }

  get component(): SourceDebuggerComponentInstance {
    return this.#runtime.component;
  }

  probeModule(module: Omit<ModuleDescriptor, "owner">): Promise<ModuleClaim> {
    return this.#runtime.probeModule(module);
  }

  activate(): Promise<SourceDebuggerComponentActivation> {
    if (this.#closePromise) {
      return Promise.reject(new Error(`SourceDebuggerComponent ${this.id} is closed`));
    }
    return (this.#activationPromise ??= this.#activate());
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #activate(): Promise<SourceDebuggerComponentActivation> {
    this.#activation = await this.#target.activate(this.#runtime, this.#route);
    return this.#activation.readyMessage === undefined
      ? {}
      : { readyMessage: this.#activation.readyMessage };
  }

  async #close(): Promise<void> {
    await this.#activationPromise?.catch(() => {});
    const errors: unknown[] = [];
    try {
      await this.#activation?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#runtime.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, `failed to close SourceDebuggerComponent ${this.id}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
