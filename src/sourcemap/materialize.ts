/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a source-map path below `baseDir` without allowing a remote source
 * map to escape the session-owned directory. Returns null for paths that are
 * absolute, platform-qualified, contain parent traversal, or contain NUL.
 */
export function containedSourcePath(baseDir: string, sourcePath: string): string | null {
  if (
    !sourcePath ||
    sourcePath.includes("\0") ||
    isAbsolute(sourcePath) ||
    /^[A-Za-z]:[\\/]/.test(sourcePath)
  ) {
    return null;
  }

  // Source maps conventionally use URL-style separators, but a hostile map can
  // use backslashes to become a traversal only on Windows. Normalize both.
  const parts = sourcePath.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) return null;

  const root = resolve(baseDir);
  const destination = resolve(root, ...parts.filter((part) => part !== "" && part !== "."));
  const rel = relative(root, destination);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return destination;
  }
  return null;
}
