/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModuleClaim, SourceDebuggerRun } from "./component.js";
import { SourceDebuggerError } from "./error.js";
import type {
  ComponentFrame,
  ComponentId,
  ComponentRunRequest,
  ComponentStop,
  SourceDebuggerComponentDescriptor,
  SourceValue,
} from "./types.js";

export const SOURCE_DEBUGGER_PROTOCOL_VERSION = "0.2" as const;

export function validateComponentDescriptor(
  descriptor: SourceDebuggerComponentDescriptor,
  expectedId?: ComponentId
): SourceDebuggerComponentDescriptor {
  if (!descriptor || typeof descriptor !== "object") {
    throw protocolError(expectedId, "describe", "component descriptor must be an object");
  }
  if (!descriptor.id || (expectedId !== undefined && descriptor.id !== expectedId)) {
    throw protocolError(
      expectedId,
      "describe",
      `component descriptor id ${String(descriptor.id)} does not match ${String(expectedId)}`
    );
  }
  if (descriptor.protocolVersion !== SOURCE_DEBUGGER_PROTOCOL_VERSION) {
    throw protocolError(
      descriptor.id,
      "describe",
      `SourceDebuggerComponent ${descriptor.id} uses unsupported protocol ${String(descriptor.protocolVersion)}`
    );
  }
  if (!descriptor.name || !descriptor.capabilities) {
    throw protocolError(descriptor.id, "describe", "component descriptor is incomplete");
  }
  for (const [name, enabled] of Object.entries(descriptor.capabilities)) {
    if (typeof enabled !== "boolean") {
      throw protocolError(
        descriptor.id,
        "describe",
        `component capability ${name} must be boolean`
      );
    }
  }
  return descriptor;
}

export function validateModuleClaim(componentId: ComponentId, claim: ModuleClaim): ModuleClaim {
  if (!claim || typeof claim !== "object" || typeof claim.supported !== "boolean") {
    throw protocolError(componentId, "probeModule", "module claim is incomplete");
  }
  if (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 100) {
    throw protocolError(
      componentId,
      "probeModule",
      `component returned invalid confidence ${String(claim.confidence)}`
    );
  }
  return claim;
}

export function validateRunResource(
  componentId: ComponentId,
  expected: Pick<ComponentRunRequest, "runId" | "role">,
  run: SourceDebuggerRun
): SourceDebuggerRun {
  if (run.id !== expected.runId || run.role !== expected.role) {
    throw protocolError(
      componentId,
      "beginRun",
      `component returned mismatched run ${run.id}/${run.role}; expected ${expected.runId}/${expected.role}`
    );
  }
  return run;
}

export function validateComponentStop(
  componentId: ComponentId,
  runId: string,
  stop: ComponentStop
): ComponentStop {
  if (stop.runId !== runId) {
    throw protocolError(
      componentId,
      "waitForStop",
      `component returned stop for ${stop.runId}; expected ${runId}`
    );
  }
  return stop;
}

export function validateComponentFrame(
  componentId: ComponentId,
  frame: ComponentFrame
): ComponentFrame {
  if (
    !frame.id ||
    !Number.isInteger(frame.physicalFrameIndex) ||
    frame.physicalFrameIndex < 0 ||
    !Number.isInteger(frame.inlineFrameIndex) ||
    frame.inlineFrameIndex < 0
  ) {
    throw protocolError(componentId, "frames", `component returned an invalid frame`);
  }
  return frame;
}

export function validateSourceValue(componentId: ComponentId, value: SourceValue): SourceValue {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.display !== "string" ||
    typeof value.hasChildren !== "boolean" ||
    (value.hasChildren && !value.id)
  ) {
    throw protocolError(
      componentId,
      "value",
      "expandable source values must include a stop-scoped id"
    );
  }
  return value;
}

function protocolError(
  componentId: ComponentId | undefined,
  operation: string,
  message: string
): SourceDebuggerError {
  return new SourceDebuggerError("protocol-error", message, {
    ...(componentId ? { componentId } : {}),
    operation,
  });
}
