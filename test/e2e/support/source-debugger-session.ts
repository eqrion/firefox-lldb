/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCliArgs } from "../../../src/cli/options.js";
import { quietLogger } from "../../../src/cli/logger.js";
import { freePort } from "../../../src/net/free-port.js";
import { loadFirefoxWasmDebuggerRuntime } from "../../../src/app/firefox-debugger.js";
import type { SourceDebuggerComponentRoute } from "../../../src/app/component-routes.js";
import type { SourceDebuggerComponentDefinition } from "../../../src/source-debugger/protocol/component.js";
import type { SourceDebuggerComponentInstance } from "../../../src/source-debugger/session/loader.js";
import { SourceDebuggerSessionRuntime } from "../../../src/source-debugger/session/runtime.js";
import { FirefoxSourceDebuggerTarget } from "../../../src/source-debugger/target/firefox/target.js";
import type { FirefoxChannel } from "../../../src/source-debugger/target/firefox/rdp/firefox.js";
import type { Logger } from "../../../src/logging.js";
import {
  closeStaticServer,
  FIXTURES,
  retrySessionSetup,
  startStaticServer,
  type StaticFixtureServer,
} from "./fixtures.js";

export interface SourceDebuggerTestSessionOptions {
  headless?: boolean;
  fire?: string;
  channel?: FirefoxChannel;
  page?: string;
  expectedModules?: number;
  routes?: readonly SourceDebuggerComponentRoute[];
  logger?: Logger;
  onOutput?: (message: string) => void;
  onConsole?: (message: string) => void;
}

/** E2E fixture using the same target, component loaders, ownership discovery,
 * and SourceDebuggerSessionRuntime lifecycle as the product CLI. Tests may
 * inspect the Firefox RDP session only for page-driving operations which are
 * intentionally outside the portable SourceDebugger protocol. */
export class SourceDebuggerTestSession {
  readonly runtime: SourceDebuggerSessionRuntime;
  readonly target: FirefoxSourceDebuggerTarget;
  readonly staticServer: StaticFixtureServer;
  readonly readyMessage: string | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    runtime: SourceDebuggerSessionRuntime,
    target: FirefoxSourceDebuggerTarget,
    staticServer: StaticFixtureServer,
    readyMessage: string | undefined
  ) {
    this.runtime = runtime;
    this.target = target;
    this.staticServer = staticServer;
    this.readyMessage = readyMessage;
  }

  get session() {
    return this.runtime.session;
  }

  get rdpSession() {
    return this.target.session;
  }

  component(id: string): SourceDebuggerComponentInstance {
    const component = this.runtime.components.find((candidate) => candidate.component.id === id);
    if (!component) throw new Error(`SourceDebuggerComponent ${id} was not instantiated`);
    return component;
  }

  definition(id: string): SourceDebuggerComponentDefinition {
    return this.runtime.catalog.entry(id).definition;
  }

  static async attach(
    fixtureName: string,
    options: SourceDebuggerTestSessionOptions = {}
  ): Promise<SourceDebuggerTestSession> {
    const fixture = FIXTURES[fixtureName];
    if (!fixture) throw new Error(`unknown fixture: ${fixtureName}`);
    return retrySessionSetup(async () => {
      const staticServer = await startStaticServer(fixture.pageDir, {
        requireAuth: fixture.requireAuth,
      });
      let target: FirefoxSourceDebuggerTarget | undefined;
      let runtime: SourceDebuggerSessionRuntime | undefined;
      try {
        const routes = options.routes ?? [{ id: "lldb", urlSubstring: "*" }];
        const explicitlyRouted = options.routes !== undefined;
        const url = `http://127.0.0.1:${staticServer.port}/${options.page ?? "index.html"}`;
        const cli = parseCliArgs([
          "--launch",
          ...((options.headless ?? true) ? ["--headless"] : []),
          ...(options.channel === "nightly"
            ? ["--nightly"]
            : options.channel === "beta"
              ? ["--beta"]
              : []),
          "--rdp-port",
          String(await freePort()),
          "--url",
          url,
          "--fire",
          options.fire ?? fixture.fire,
        ]);
        const logger = options.logger ?? quietLogger(Boolean(process.env.E2E_RUNTIME_VERBOSE));
        target = await FirefoxSourceDebuggerTarget.start({
          ...cli,
          logger,
          onOutput: options.onOutput,
          onConsole: options.onConsole,
        });
        await waitForModules(target, options.expectedModules ?? 1);
        runtime = await loadFirefoxWasmDebuggerRuntime({
          target,
          routes,
          routedComponents: explicitlyRouted,
          logger,
          onOutput: options.onOutput,
          verbose: Boolean(process.env.E2E_RUNTIME_VERBOSE),
        });
        const activation = await runtime.activate();
        return new SourceDebuggerTestSession(
          runtime,
          target,
          staticServer,
          activation.readyMessage
        );
      } catch (error) {
        if (runtime) await runtime.close().catch(() => {});
        else await target?.close().catch(() => {});
        await closeStaticServer(staticServer).catch(() => {});
        throw error;
      }
    });
  }

  /** Schedule page code after the next debugger run is armed. */
  async schedule(expression: string, delayMs = 100): Promise<void> {
    await this.rdpSession.evaluate(`setTimeout(() => { ${expression} }, ${delayMs})`);
  }

  evaluate(expression: string): void {
    const wrapped = `(function poll(){try{${expression}}catch(e){setTimeout(poll,20);}})()`;
    void this.rdpSession.evaluate(wrapped).catch(() => {});
  }

  pageUrl(relativePath: string): string {
    return `http://127.0.0.1:${this.staticServer.port}/${relativePath}`;
  }

  shutdown(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.runtime.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await closeStaticServer(this.staticServer);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "source debugger test session cleanup failed");
    }
  }
}

async function waitForModules(
  target: FirefoxSourceDebuggerTarget,
  expectedModules: number
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await target.modules()).length >= expectedModules) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected ${expectedModules} Wasm modules before component discovery`);
}
