/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import type { SourceDebuggerComponentWorkerPorts } from "../../transport/isolate.js";
import type { CommandResult } from "../../protocol/types.js";

export interface LldbIsolateWorkerData extends SourceDebuggerComponentWorkerPorts {
  controlPort: MessagePort;
  options: {
    id?: string;
    name?: string;
    observerResumesTarget: boolean;
    exclusiveModules: boolean;
    verbose: boolean;
  };
}

export type LldbIsolateControlMethod = "start-target" | "attach" | "command" | "close";

export interface LldbIsolateControlRequest {
  type: "lldb-isolate-control-request";
  id: number;
  method: LldbIsolateControlMethod;
  args: unknown[];
}

export interface LldbIsolateControlResponse {
  type: "lldb-isolate-control-response";
  id: number;
  result?: unknown;
  error?: { name: string; message: string; stack?: string };
}

export interface LldbIsolateReady {
  type: "lldb-isolate-ready";
}

export interface LldbIsolateInitializationError {
  type: "lldb-isolate-initialization-error";
  error: { name: string; message: string; stack?: string };
}

export interface LldbIsolateLog {
  type: "lldb-isolate-log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export type LldbIsolateHostMessage =
  | LldbIsolateControlResponse
  | LldbIsolateReady
  | LldbIsolateInitializationError
  | LldbIsolateLog;

export type LldbIsolateWorkerMessage = LldbIsolateControlRequest;

export interface LldbIsolateControlResults {
  "start-target": void;
  attach: string;
  command: CommandResult;
  close: void;
}
