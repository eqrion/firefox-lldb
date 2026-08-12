/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import type { RdpDebuggeeResumeAction } from "../gdb/rdp-debuggee.js";
import type { CommandResult } from "./types.js";

export interface LldbIsolateWorkerData {
  componentPort: MessagePort;
  controlPort: MessagePort;
  options: {
    id?: string;
    name?: string;
    observerResumesTarget: boolean;
    exclusiveModules: boolean;
    verbose: boolean;
  };
}

export type LldbIsolateControlMethod =
  | "bridge-rsp"
  | "connect-platform"
  | "attach"
  | "command"
  | "close";

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

export interface LldbIsolateResume {
  type: "lldb-isolate-resume";
  id: number;
  action: RdpDebuggeeResumeAction;
}

export interface LldbIsolateRelease {
  type: "lldb-isolate-release";
  id: number;
  action: RdpDebuggeeResumeAction;
}

export interface LldbIsolateSynchronizeStop {
  type: "lldb-isolate-synchronize-stop";
  tid?: number;
}

export interface LldbIsolateAbortStop {
  type: "lldb-isolate-abort-stop";
  tid?: number;
}

export type LldbIsolateHostMessage =
  | LldbIsolateControlResponse
  | LldbIsolateReady
  | LldbIsolateInitializationError
  | LldbIsolateLog
  | LldbIsolateRelease
  | LldbIsolateSynchronizeStop
  | LldbIsolateAbortStop;

export type LldbIsolateWorkerMessage = LldbIsolateControlRequest | LldbIsolateResume;

export interface LldbIsolateControlResults {
  "bridge-rsp": number;
  "connect-platform": void;
  attach: string;
  command: CommandResult;
  close: void;
}
