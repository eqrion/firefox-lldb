/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from "node:test";
import { runSourceDebuggerComponentConformance } from "./support/source-debugger-component-conformance.ts";
import { SourceDebuggerTestSession } from "./support/source-debugger-session.ts";

test("real installed debuggers satisfy the SourceDebuggerComponent contract", async (t) => {
  const fixture = await SourceDebuggerTestSession.attach("two_components", {
    page: "mixed-wat.html",
    expectedModules: 2,
    fire: "",
  });
  try {
    await t.test("LLDB component", async (componentTest) => {
      await runSourceDebuggerComponentConformance(componentTest, fixture, {
        componentId: "lldb",
        moduleUrlIncludes: "component=dwarf",
        breakpointFunction: "compute_factorial",
        trigger: () => fixture.schedule("debuggersReady.then(() => runDwarf())"),
        expectedFrame: /compute_factorial/,
        evaluation: { expression: "n", display: /\b8\b/ },
      });
    });

    await t.test("Wasm text component", async (componentTest) => {
      await runSourceDebuggerComponentConformance(componentTest, fixture, {
        componentId: "wasm-text",
        moduleUrlIncludes: "component=wat",
        breakpointFunction: "wat_factorial",
        trigger: () => fixture.schedule("debuggersReady.then(() => runWat())"),
        expectedFrame: /wat_factorial/,
        evaluation: { expression: "$local0", display: /\b7\b/ },
        source: {
          language: "webassembly",
          url: /^wasm-text:\/\/.+\/module\.wat$/,
          content: /\(func \$wat_factorial/,
        },
      });
    });
  } finally {
    await fixture.shutdown();
  }
});
