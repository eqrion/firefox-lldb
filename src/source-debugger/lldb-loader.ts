/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { noopLogger, type Logger } from "../logging.js";
import type {
  ModuleClaim,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentInstance,
} from "./component.js";
import { componentForModuleUrl, type SourceDebuggerComponentRoute } from "./config.js";
import type { FirefoxGdbRspProjection, FirefoxSourceDebuggerTarget } from "./firefox-target.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import { lldbSourceDebuggerDescriptor, probeLldbSourceDebuggerModule } from "./lldb-component.js";
import {
  IsolatedLldbComponentRuntime,
  type IsolatedLldbComponentRuntimeOptions,
} from "./lldb-isolate.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentActivation,
  SourceDebuggerComponentLoader,
  LoadedSourceDebuggerComponentDefinition,
} from "./loader.js";
import type { ModuleDescriptor } from "./types.js";

export interface LldbSourceDebuggerTargetOptions {
  target: FirefoxSourceDebuggerTarget;
  routes: readonly SourceDebuggerComponentRoute[];
  routedComponents?: boolean;
  /** Filter Wasm images from the target's session ownership registry instead
   * of exposing every module to LLDB. JavaScript remains visible so LLDB can
   * still contribute JS frames to a mixed stack. */
  ownershipFilteredModules?: boolean;
  logger?: Logger;
  /** Status and lifecycle text for the frontend. */
  onOutput?: (message: string) => void;
}

interface LldbTargetActivation extends SourceDebuggerComponentActivation {
  close(): Promise<void>;
}

/** Firefox target integration used by the installed LLDB ecosystem. It owns
 * every LLDB-specific platform/RSP/attach detail; neither the generic session
 * runtime nor its frontend needs to know how LLDB reaches the debuggee. */
export class LldbSourceDebuggerTarget {
  readonly #target: FirefoxSourceDebuggerTarget;
  readonly #routes: readonly SourceDebuggerComponentRoute[];
  readonly #routedComponents: boolean;
  readonly #ownershipFilteredModules: boolean;
  readonly #logger: Logger;
  readonly #onOutput: (message: string) => void;
  readonly #activeRuntimes = new Map<string, IsolatedLldbComponentRuntime>();
  #primaryId: string | undefined;

  constructor(options: LldbSourceDebuggerTargetOptions) {
    this.#target = options.target;
    this.#routes = options.routes;
    this.#routedComponents = options.routedComponents ?? false;
    this.#ownershipFilteredModules = options.ownershipFilteredModules ?? false;
    this.#logger = options.logger ?? noopLogger;
    this.#onOutput = options.onOutput ?? (() => {});
    this.#target.onDetached(() => {
      for (const runtime of this.#activeRuntimes.values()) {
        void runtime
          .command("process detach")
          .catch((error) =>
            this.#logger.debug(`[cleanup] LLDB detach failed: ${errorMessage(error)}`)
          );
      }
    });
  }

  async activate(
    runtime: IsolatedLldbComponentRuntime,
    route: SourceDebuggerComponentRoute
  ): Promise<LldbTargetActivation> {
    if (this.#activeRuntimes.has(runtime.id)) {
      throw new Error(`SourceDebuggerComponent ${runtime.id} is already active`);
    }
    const primary = this.#primaryId === undefined;
    let projection: FirefoxGdbRspProjection | undefined;
    // Navigation can detach the RDP target while LLDB's initial attach is
    // still pending. Treat the runtime as participating before attach so the
    // detach handler resets it and the next attach attempt starts cleanly.
    this.#activeRuntimes.set(runtime.id, runtime);
    try {
      if (!primary) this.#onOutput(`attaching ${route.id}...`);
      projection = await this.#target.createGdbRspProjection({
        componentId: runtime.id,
        primary,
        wrapConnectPort: runtime.bridgeTcp,
        runControl: runtime.runControl,
        ...(this.#routedComponents
          ? {
              moduleFilter: (url: string, kind: "wasm" | "javascript") =>
                kind === "wasm" && componentForModuleUrl(this.#routes, url).id === route.id,
            }
          : this.#ownershipFilteredModules
            ? {
                moduleFilter: (url: string, kind: "wasm" | "javascript") =>
                  kind === "javascript" || this.#target.moduleOwner(url) === runtime.id,
              }
            : {}),
      });
      if (primary) this.#primaryId = runtime.id;

      await runtime.connectPlatform(projection.port);
      await runtime.command("command alias attach process attach --plugin wasm");
      if (!primary) {
        // Let the connect-mode tab watcher populate its stable PID map before
        // the attach handshake asks it to launch the per-tab RSP server.
        await new Promise((resolve) => setTimeout(resolve, 250));
        await runtime.command("platform process list");
      }

      const greeting =
        "firefox-lldb source debugger — `attach --pid N` to attach, `help` for generic commands.";
      let readyMessage: string | undefined;
      if (this.#target.automaticAttach) {
        if (primary) this.#onOutput(`${greeting}\nattaching...`);
        const attached = await runtime.attach(1, {
          onRetry: (attempt) =>
            this.#onOutput(
              primary
                ? `automatic attach attempt ${attempt} was interrupted; retrying...`
                : `${route.id} attach attempt ${attempt} was interrupted; retrying...`
            ),
        });
        if (primary) readyMessage = attached;
      } else {
        const result = await runtime.command("platform process list");
        if (primary) readyMessage = `${greeting}\n${result.output.trimEnd()}`;
      }

      return this.#activationHandle(runtime.id, projection, readyMessage, primary);
    } catch (error) {
      this.#activeRuntimes.delete(runtime.id);
      if (this.#primaryId === runtime.id) this.#clearPrimary(runtime.id);
      await projection
        ?.close()
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
    projection: FirefoxGdbRspProjection,
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
            await projection.close();
          } finally {
            if (primary) this.#clearPrimary(componentId);
          }
        })()),
    };
  }

  #clearPrimary(componentId: string): void {
    if (this.#primaryId !== componentId) return;
    this.#primaryId = undefined;
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

  async loadDefinition(): Promise<LoadedSourceDebuggerComponentDefinition> {
    const definition: SourceDebuggerComponentDefinition = {
      describe: async () => lldbSourceDebuggerDescriptor({ id: this.id, name: this.options.name }),
      probeModule: probeLldbSourceDebuggerModule,
    };
    return {
      id: this.id,
      definition,
      probeModule: definition.probeModule,
      close: () => {},
    };
  }

  async instantiate(
    host: SourceDebuggerComponentHostBinding
  ): Promise<LoadedSourceDebuggerComponent> {
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
