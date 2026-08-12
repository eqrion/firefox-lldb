/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProbeModuleOwnerResolver,
  probeModuleClaims,
  type SourceDebuggerComponentProbe,
} from "../../src/source-debugger/ownership.js";

const module = { id: "app", url: "https://example.test/app.wasm" };

function probe(
  id: string,
  claim: SourceDebuggerComponentProbe["probeModule"]
): SourceDebuggerComponentProbe {
  return { id, probeModule: claim };
}

test("module discovery selects the unique highest-confidence claim", async () => {
  const resolve = createProbeModuleOwnerResolver([
    probe("lldb", async () => ({
      supported: true,
      confidence: 50,
      reason: "generic DWARF fallback",
    })),
    probe("dart", async () => ({
      supported: true,
      confidence: 90,
      reason: "Dart debug metadata",
    })),
    probe("dotnet", async () => ({ supported: false, confidence: 100 })),
  ]);

  assert.equal(await resolve(module), "dart");
});

test("module discovery rejects a tie instead of depending on registration order", async () => {
  const resolve = createProbeModuleOwnerResolver([
    probe("lldb-a", async () => ({ supported: true, confidence: 50, reason: "DWARF" })),
    probe("lldb-b", async () => ({ supported: true, confidence: 50, reason: "DWARF" })),
  ]);

  await assert.rejects(
    resolve(module),
    /ambiguous SourceDebuggerComponent claims at confidence 50: lldb-a \(DWARF\), lldb-b \(DWARF\)/
  );
});

test("module discovery reports why no component claimed a module", async () => {
  const resolve = createProbeModuleOwnerResolver([
    probe("dart", async () => ({
      supported: false,
      confidence: 0,
      reason: "no Dart debug metadata",
    })),
    probe("dotnet", async () => ({
      supported: false,
      confidence: 0,
      reason: "no managed debug directory",
    })),
  ]);

  await assert.rejects(resolve(module), /dart: no Dart debug metadata; dotnet:/);
});

test("module discovery fails closed on invalid or failed probes", async () => {
  await assert.rejects(
    probeModuleClaims(
      [probe("bad-confidence", async () => ({ supported: true, confidence: 101 }))],
      module
    ),
    /invalid confidence 101/
  );
  await assert.rejects(
    probeModuleClaims(
      [
        probe("broken", async () => {
          throw new Error("component crashed");
        }),
      ],
      module
    ),
    /broken failed to probe.*component crashed/
  );
});

test("module discovery bounds each component probe", async () => {
  const resolve = createProbeModuleOwnerResolver([probe("hung", () => new Promise(() => {}))], {
    timeoutMs: 5,
  });

  await assert.rejects(resolve(module), /hung module probe timed out after 5ms/);
});
