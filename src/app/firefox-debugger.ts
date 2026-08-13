/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Logger } from "../logging.js";
import {
  LldbComponentActivator,
  LldbSourceDebuggerComponentLoader,
} from "../source-debugger/components/lldb/loader.js";
import { WasmSourceDebuggerComponentLoader } from "../source-debugger/components/wasm-text/loader.js";
import {
  createRoutedModuleOwnerResolver,
  type SourceDebuggerComponentRoute,
} from "./component-routes.js";
import { SourceDebuggerSessionRuntime } from "../source-debugger/session/runtime.js";
import type { FirefoxSourceDebuggerTarget } from "../source-debugger/target/firefox/target.js";

export interface FirefoxWasmDebuggerRuntimeOptions {
  target: FirefoxSourceDebuggerTarget;
  routes: readonly SourceDebuggerComponentRoute[];
  /** Explicit URL routes are a compatibility mode for several instances of
   * the same debugger ecosystem. Ordinary discovery leaves this false. */
  routedComponents?: boolean;
  logger?: Logger;
  onOutput?: (message: string) => void;
  verbose?: boolean;
}

/** Product composition root. This is the only production code which knows
 * both the Firefox target and the set of debugger ecosystems we install. */
export function loadFirefoxWasmDebuggerRuntime(
  options: FirefoxWasmDebuggerRuntimeOptions
): Promise<SourceDebuggerSessionRuntime> {
  const { target, routes } = options;
  const routedComponents = options.routedComponents ?? false;
  const activator = new LldbComponentActivator({
    automaticAttach: target.automaticAttach,
    onDetached: (listener) => void target.onDetached(listener),
    logger: options.logger,
    onOutput: options.onOutput,
  });
  const lldbLoaders = routes.map(
    (route) =>
      new LldbSourceDebuggerComponentLoader(activator, route.id, {
        name: routes.length === 1 && route.id === "lldb" ? "LLDB" : `LLDB (${route.id})`,
        logger: options.logger,
        observerResumesTarget: false,
        exclusiveModules: true,
        verbose: options.verbose ?? false,
      })
  );

  return SourceDebuggerSessionRuntime.load({
    loaders: [...lldbLoaders, new WasmSourceDebuggerComponentLoader()],
    target,
    ...(routedComponents
      ? {
          createModuleOwnerResolver: (
            definitions: Parameters<typeof createRoutedModuleOwnerResolver>[1]
          ) => createRoutedModuleOwnerResolver(routes, definitions),
        }
      : {}),
    eagerComponentIds: routedComponents ? routes.map(({ id }) => id) : [],
    fallbackComponentIds: routes.map(({ id }) => id),
    logger: options.logger,
  });
}
