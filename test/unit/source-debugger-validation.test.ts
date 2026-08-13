/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lldbSourceDebuggerDescriptor } from "../../src/source-debugger/components/lldb/component.js";
import { wasmSourceDebuggerDescriptor } from "../../src/source-debugger/components/wasm-text/component.js";
import type { SourceDebuggerRun } from "../../src/source-debugger/protocol/component.js";
import { SourceDebuggerError } from "../../src/source-debugger/protocol/error.js";
import type {
  SourceDebuggerComponentDescriptor,
  SourceValue,
} from "../../src/source-debugger/protocol/types.js";
import {
  SOURCE_DEBUGGER_PROTOCOL_VERSION,
  validateComponentDescriptor,
  validateComponentStop,
  validateModuleClaim,
  validateRunResource,
  validateSourceValue,
} from "../../src/source-debugger/protocol/validation.js";

test("production component descriptors conform to protocol 0.2", () => {
  assert.equal(SOURCE_DEBUGGER_PROTOCOL_VERSION, "0.2");
  assert.equal(validateComponentDescriptor(lldbSourceDebuggerDescriptor()).id, "lldb");
  assert.equal(validateComponentDescriptor(wasmSourceDebuggerDescriptor()).id, "wasm-text");
});

test("protocol validation rejects unusable descriptors, resources, and values", () => {
  assertProtocolError(() =>
    validateComponentDescriptor({
      ...lldbSourceDebuggerDescriptor(),
      protocolVersion: "0.1",
    } as unknown as SourceDebuggerComponentDescriptor)
  );
  assertProtocolError(() =>
    validateModuleClaim("fake", { supported: true, confidence: Number.NaN })
  );
  assertProtocolError(() =>
    validateRunResource("fake", { runId: "run-1", role: "driver" }, {
      id: "wrong",
      role: "driver",
    } as SourceDebuggerRun)
  );
  assertProtocolError(() =>
    validateComponentStop("fake", "run-1", {
      runId: "run-2",
      disposition: "accepted",
      reason: { kind: "stopped" },
    })
  );
  assertProtocolError(() =>
    validateSourceValue("fake", { display: "{...}", hasChildren: true } as unknown as SourceValue)
  );
});

function assertProtocolError(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof SourceDebuggerError);
    assert.equal(error.code, "protocol-error");
    return true;
  });
}
