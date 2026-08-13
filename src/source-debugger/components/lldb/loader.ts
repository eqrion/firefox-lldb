/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { noopLogger, type Logger } from "../../../logging.js";
import type {
  ModuleClaim,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponent,
  SourceDebuggerComponentHost,
} from "../../protocol/component.js";
import type { SourceDebuggerComponentRoute } from "../../config.js";
import { lldbSourceDebuggerDescriptor, probeLldbSourceDebuggerModule } from "./component.js";
import {
  IsolatedLldbComponentRuntime,
  type IsolatedLldbComponentRuntimeOptions,
} from "./isolate.js";
import type {
  LoadedSourceDebuggerComponent,
  SourceDebuggerComponentActivation,
  SourceDebuggerComponentLoader,
  LoadedSourceDebuggerComponentDefinition,
} from "../../session/loader.js";
import type { ModuleDescriptor } from "../../protocol/types.js";

export interface LldbComponentActivatorOptions {
  automaticAttach: boolean;
  onDetached?: (listener: () => void) => void;
  logger?: Logger;
  /** Status and lifecycle text for the frontend. */
  onOutput?: (message: string) => void;
}

interface LldbTargetActivation extends SourceDebuggerComponentActivation {
  close(): Promise<void>;
}

/** Engine lifecycle used by the installed LLDB ecosystem. Target access comes
 * only from the imported SourceDebuggerComponentHost; these options carry the
 * frontend's attach policy and a transport-neutral detach notification. */
export class LldbComponentActivator {
  readonly #automaticAttach: boolean;
  readonly #logger: Logger;
  readonly #onOutput: (message: string) => void;
  readonly #activeRuntimes = new Map<string, IsolatedLldbComponentRuntime>();
  #primaryId: string | undefined;

  constructor(options: LldbComponentActivatorOptions) {
    this.#automaticAttach = options.automaticAttach;
    this.#logger = options.logger ?? noopLogger;
    this.#onOutput = options.onOutput ?? (() => {});
    options.onDetached?.(() => {
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
    // Navigation can detach the RDP target while LLDB's initial attach is
    // still pending. Treat the runtime as participating before attach so the
    // detach handler resets it and the next attach attempt starts cleanly.
    this.#activeRuntimes.set(runtime.id, runtime);
    try {
      if (!primary) this.#onOutput(`attaching ${route.id}...`);
      await runtime.startTarget();
      if (primary) this.#primaryId = runtime.id;

      await runtime.command("command alias attach process attach --plugin wasm");
      if (!primary) {
        await runtime.command("platform process list");
      }

      const greeting =
        "firefox-wasm-debugger — `attach --pid N` to attach, `help` for generic commands.";
      let readyMessage: string | undefined;
      if (this.#automaticAttach) {
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

      return this.#activationHandle(runtime.id, readyMessage, primary);
    } catch (error) {
      this.#activeRuntimes.delete(runtime.id);
      if (this.#primaryId === runtime.id) this.#clearPrimary(runtime.id);
      throw error;
    }
  }

  #activationHandle(
    componentId: string,
    readyMessage: string | undefined,
    primary: boolean
  ): LldbTargetActivation {
    let closePromise: Promise<void> | undefined;
    return {
      ...(readyMessage === undefined ? {} : { readyMessage }),
      close: () =>
        (closePromise ??= (async () => {
          this.#activeRuntimes.delete(componentId);
          if (primary) this.#clearPrimary(componentId);
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
    private readonly activator: LldbComponentActivator,
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

  async instantiate(host: SourceDebuggerComponentHost): Promise<LoadedSourceDebuggerComponent> {
    const runtime = await IsolatedLldbComponentRuntime.create({
      ...this.options,
      id: this.id,
      host,
    });
    return new LoadedLldbSourceDebuggerComponent(runtime, this.activator, this.route);
  }
}

class LoadedLldbSourceDebuggerComponent implements LoadedSourceDebuggerComponent {
  readonly #runtime: IsolatedLldbComponentRuntime;
  readonly #activator: LldbComponentActivator;
  readonly #route: SourceDebuggerComponentRoute;
  #activation: LldbTargetActivation | undefined;
  #activationPromise: Promise<SourceDebuggerComponentActivation> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    runtime: IsolatedLldbComponentRuntime,
    activator: LldbComponentActivator,
    route: SourceDebuggerComponentRoute
  ) {
    this.#runtime = runtime;
    this.#activator = activator;
    this.#route = route;
  }

  get id(): string {
    return this.#runtime.id;
  }

  get definition(): SourceDebuggerComponentDefinition {
    return this.#runtime.definition;
  }

  get component(): SourceDebuggerComponent {
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
    this.#activation = await this.#activator.activate(this.#runtime, this.#route);
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
