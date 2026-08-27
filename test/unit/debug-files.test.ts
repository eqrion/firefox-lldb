/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { DebugFileRegistry } from "../../src/core/debug-files.js";
import type { Logger } from "../../src/logging.js";

const MODULE_URL = "https://example.test/app/math.wasm";

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} },
  };
}

/** Stub global fetch for the duration of `body`, recording requested URLs. */
async function withFetch(
  respond: (url: string) => { ok: boolean; body?: Uint8Array },
  body: (urls: string[]) => Promise<void>
): Promise<void> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const res = respond(url);
    return {
      ok: res.ok,
      status: res.ok ? 200 : 404,
      statusText: res.ok ? "OK" : "Not Found",
      arrayBuffer: async () => (res.body ?? new Uint8Array()).buffer,
    };
  }) as typeof globalThis.fetch;
  try {
    await body(urls);
  } finally {
    globalThis.fetch = original;
  }
}

test("a relative debug path resolves against the module URL", async () => {
  const registry = new DebugFileRegistry();
  registry.register("math.debug.wasm", MODULE_URL);

  await withFetch(
    () => ({ ok: true, body: new Uint8Array([1, 2, 3]) }),
    async (urls) => {
      const bytes = await registry.read("//math.debug.wasm");
      assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
      assert.deepEqual(urls, ["https://example.test/app/math.debug.wasm"]);
    }
  );
});

test("an absolute SEPARATE_DWARF_URL is used as recorded", async () => {
  const registry = new DebugFileRegistry();
  registry.register("https://symbols.test/build/math.debug.wasm", MODULE_URL);

  await withFetch(
    () => ({ ok: true, body: new Uint8Array([7]) }),
    async (urls) => {
      await registry.read("//math.debug.wasm");
      assert.deepEqual(urls, ["https://symbols.test/build/math.debug.wasm"]);
    }
  );
});

test("every directory LLDB searches resolves to the same debug file", async () => {
  const registry = new DebugFileRegistry();
  // emcc records the path relative to the wasm; LLDB only ever asks by basename.
  registry.register("dwarf/math.debug.wasm", MODULE_URL);

  await withFetch(
    () => ({ ok: true, body: new Uint8Array([1]) }),
    async (urls) => {
      for (const path of [
        "//math.debug.wasm",
        "//.debug/math.debug.wasm",
        "/tmp/math.debug.wasm",
      ]) {
        assert.notEqual(await registry.read(path), null, path);
      }
      assert.deepEqual(new Set(urls), new Set(["https://example.test/app/dwarf/math.debug.wasm"]));
    }
  );
});

test("unregistered paths are left to the rest of the provider", async () => {
  const registry = new DebugFileRegistry();
  registry.register("math.debug.wasm", MODULE_URL);

  await withFetch(
    () => ({ ok: true, body: new Uint8Array([1]) }),
    async (urls) => {
      // Source text, LLDB's .dwp probes, and its is-this-a-directory probe.
      assert.equal(await registry.read("/home/user/math.cpp"), null);
      assert.equal(await registry.read("//math.debug.wasm.dwp"), null);
      assert.equal(await registry.read("//math.debug.wasm/"), null);
      assert.deepEqual(urls, []);
    }
  );
});

test("a debug file that cannot be fetched warns instead of failing the session", async () => {
  const { logger, warnings } = recordingLogger();
  const registry = new DebugFileRegistry(logger);
  registry.register("math.debug.wasm", MODULE_URL);

  await withFetch(
    () => ({ ok: false }),
    async () => {
      assert.equal(await registry.read("//math.debug.wasm"), null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /could not fetch separate DWARF/);
      assert.match(warnings[0], /math\.debug\.wasm/);
    }
  );
});

test("two modules naming the same debug file basename warn about the collision", () => {
  const { logger, warnings } = recordingLogger();
  const registry = new DebugFileRegistry(logger);
  registry.register("math.debug.wasm", MODULE_URL);
  registry.register("math.debug.wasm", MODULE_URL);
  assert.deepEqual(warnings, [], "re-registering the same module URL is not a collision");

  registry.register("math.debug.wasm", "https://other.test/math.wasm");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /two modules name a separate DWARF file math\.debug\.wasm/);
});
