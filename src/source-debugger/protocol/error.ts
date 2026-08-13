/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentId } from "./types.js";

/** Stable, transportable error categories for frontend and component code.
 * Human-readable messages remain diagnostic; callers should branch on code. */
export type SourceDebuggerErrorCode =
  | "unsupported-operation"
  | "invalid-state"
  | "not-found"
  | "ambiguous"
  | "component-unavailable"
  | "protocol-error";

export interface SourceDebuggerErrorOptions {
  componentId?: ComponentId;
  operation?: string;
  cause?: unknown;
}

export class SourceDebuggerError extends Error {
  readonly code: SourceDebuggerErrorCode;
  readonly componentId: ComponentId | undefined;
  readonly operation: string | undefined;

  constructor(
    code: SourceDebuggerErrorCode,
    message: string,
    options: SourceDebuggerErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SourceDebuggerError";
    this.code = code;
    this.componentId = options.componentId;
    this.operation = options.operation;
  }
}

export function isSourceDebuggerError(error: unknown): error is SourceDebuggerError {
  return error instanceof SourceDebuggerError;
}
