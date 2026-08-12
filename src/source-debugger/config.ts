/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentId } from "./types.js";

export interface SourceDebuggerComponentRoute {
  id: ComponentId;
  urlSubstring: string;
}

export function parseComponentRoutes(values: string[]): SourceDebuggerComponentRoute[] {
  if (values.length === 0) return [{ id: "lldb", urlSubstring: "*" }];
  const routes = values.map((value) => {
    const separator = value.indexOf("=");
    const id = value.slice(0, separator).trim();
    const urlSubstring = value.slice(separator + 1).trim();
    if (separator < 1 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || !urlSubstring) {
      throw new Error(`invalid --component ${JSON.stringify(value)}; expected ID=URL_SUBSTRING`);
    }
    return { id, urlSubstring };
  });
  if (new Set(routes.map(({ id }) => id)).size !== routes.length) {
    throw new Error("--component ids must be unique");
  }
  if (routes.filter(({ urlSubstring }) => urlSubstring === "*").length > 1) {
    throw new Error("at most one --component route may use the * fallback");
  }
  return routes;
}

export function componentForModuleUrl(
  routes: SourceDebuggerComponentRoute[],
  url: string
): SourceDebuggerComponentRoute {
  const matches = routes.filter(
    ({ urlSubstring }) => urlSubstring !== "*" && url.includes(urlSubstring)
  );
  if (matches.length > 1) {
    throw new Error(
      `Wasm module ${url} matches multiple components: ${matches.map(({ id }) => id).join(", ")}`
    );
  }
  const route = matches[0] ?? routes.find(({ urlSubstring }) => urlSubstring === "*");
  if (!route) throw new Error(`no SourceDebuggerComponent owns Wasm module ${url}`);
  return route;
}
