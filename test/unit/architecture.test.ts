/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

test("the package exposes only the debugger CLI, MCP, and SourceDebugger APIs", () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    name: string;
    bin: Record<string, string>;
    exports: Record<string, unknown>;
  };

  assert.equal(packageJson.name, "firefox-wasm-debugger");
  assert.deepEqual(Object.keys(packageJson.bin).sort(), [
    "firefox-wasm-debugger",
    "firefox-wasm-debugger-mcp",
  ]);
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./protocol"]);
});

test("portable protocol and session layers do not import engine or Firefox internals", () => {
  for (const file of sourceFiles("src/source-debugger/protocol")) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      assert.match(specifier, /^\.\//, `${file} imports non-protocol dependency ${specifier}`);
    }
  }

  for (const file of sourceFiles("src/source-debugger/session")) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /components\/lldb|target\/firefox|\/rdp\//, file);
  }

  const lldbLoader = readFileSync(
    resolve(ROOT, "src/source-debugger/components/lldb/loader.ts"),
    "utf8"
  );
  assert.doesNotMatch(lldbLoader, /target\/firefox|RdpWasmSession/, "LLDB loader target coupling");
});

test("production-path e2e harnesses cannot fall back to the legacy LLDB bootstrap", () => {
  for (const relativePath of [
    "test/e2e/repl-harness.mjs",
    "test/e2e/support/source-debugger-session.ts",
    "test/e2e/support/source-debugger-component-conformance.ts",
  ]) {
    const source = readFileSync(resolve(ROOT, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /lldb-wasm|lldb-platform-session|startLldbTestPlatform|LldbSourceDebuggerComponent\b/,
      relativePath
    );
  }
});

function sourceFiles(relativeDirectory: string): string[] {
  const directory = resolve(ROOT, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(`${relativeDirectory}/${entry.name}`)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}
