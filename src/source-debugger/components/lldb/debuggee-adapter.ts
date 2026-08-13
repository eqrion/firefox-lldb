/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildSyntheticModule } from "../../../gdb/synthetic-module.js";
import type {
  WasmDebuggee,
  WasmDebuggeeDeferredResume,
  WasmDebuggeeResourceCall,
  WasmDebuggeeResourceRef,
} from "../../protocol/wasm-debuggee.js";

export const SOURCE_DEBUGGER_ABORT_FUNCTION = "__source_debugger_abort__";

const ABORT_MODULE_ID = 0x7fff_fff0;
const ABORT_INSTANCE_ID = 0x7fff_fff1;
const ABORT_FRAME_ID = 0x7fff_fff2;
const ABORT_SOURCE = "__source_debugger_abort__.wasm";

type Dispatch = (request: WasmDebuggeeResourceCall) => Promise<unknown>;

/** Private LLDB-to-Wasm adapter. It translates the resource calls made by the
 * gdbstub component into the portable WasmDebuggee import and owns every
 * LLDB-specific accommodation, including the abort sentinel. */
export class LldbWasmDebuggeeAdapter {
  readonly #abortModule = buildSyntheticModule({
    name: ABORT_SOURCE,
    compDir: "/",
    lineCount: 1,
    subprogramName: SOURCE_DEBUGGER_ABORT_FUNCTION,
  });
  #abortRequested = false;
  #abortTid: number | undefined;
  #abortParent: WasmDebuggeeResourceRef | null = null;

  constructor(
    private readonly debuggee: WasmDebuggee,
    private readonly onResume: (resume: WasmDebuggeeDeferredResume) => void,
    private readonly usesAbortSentinel: boolean
  ) {}

  readonly dispatch: Dispatch = async (request) => {
    if (request.type === "Debuggee") {
      if (request.method === "continue" || request.method === "singleStep") {
        this.#abortRequested = false;
        this.#abortTid = undefined;
        this.#abortParent = null;
      } else if (request.method === "allModules" && this.usesAbortSentinel) {
        const modules = (await this.#invoke(request)) as WasmDebuggeeResourceRef[];
        return [...modules, resource("Module", ABORT_MODULE_ID)];
      } else if (request.method === "exitFrames" && this.#isAbortThread(request.args[0])) {
        const physical = (await this.#invoke(request)) as WasmDebuggeeResourceRef[];
        this.#abortParent = physical[0] ?? null;
        return [resource("Frame", ABORT_FRAME_ID)];
      }
    }

    if (request.type === "EventFuture" && request.method === "finish") {
      const value = await this.#invoke(request);
      if (this.#abortRequested && this.#abortTid === undefined) {
        this.#abortTid = Number(
          await this.#invoke({ type: "Debuggee", id: 0, method: "stoppedThread", args: [] })
        );
      }
      return value;
    }

    if (this.usesAbortSentinel && request.id === ABORT_MODULE_ID && request.type === "Module") {
      switch (request.method) {
        case "uniqueId":
          return BigInt(ABORT_MODULE_ID);
        case "name":
          return ABORT_SOURCE;
        case "bytecode":
          return this.#abortModule.bytecode;
        case "addBreakpoint":
          return request.args.at(-1) as number;
        case "removeBreakpoint":
          return null;
      }
    }

    if (this.usesAbortSentinel && request.id === ABORT_INSTANCE_ID && request.type === "Instance") {
      if (request.method === "getModule") return resource("Module", ABORT_MODULE_ID);
      if (request.method === "uniqueId") return BigInt(ABORT_INSTANCE_ID);
    }

    if (this.usesAbortSentinel && request.id === ABORT_FRAME_ID && request.type === "Frame") {
      switch (request.method) {
        case "getInstance":
          return resource("Instance", ABORT_INSTANCE_ID);
        case "getFuncIndex":
          return 0;
        case "getPc":
          return this.#abortModule.codeOffset + 1;
        case "getLocals":
        case "getStack":
          return [];
        case "parentFrame":
          return this.#abortParent;
      }
    }

    return this.#invoke(request);
  };

  synchronizeStop(tid?: number): Promise<void> {
    return this.debuggee.completeWaitAtCurrentStop({
      reason: "synchronized",
      ...(tid === undefined ? {} : { threadId: String(tid) }),
    });
  }

  abortStop(tid?: number): Promise<void> {
    this.#abortRequested = true;
    this.#abortTid = tid;
    return this.debuggee.completeWaitAtCurrentStop({
      reason: "breakpoint",
      ...(tid === undefined ? {} : { threadId: String(tid) }),
    });
  }

  dispose(): Promise<void> {
    return this.debuggee.dispose();
  }

  async #invoke(request: WasmDebuggeeResourceCall): Promise<unknown> {
    const result = await this.debuggee.invokeResource(request);
    if (result.resume) this.onResume(result.resume);
    return result.value;
  }

  #isAbortThread(value: unknown): boolean {
    return (
      this.usesAbortSentinel &&
      this.#abortRequested &&
      (this.#abortTid === undefined || Number(value) === this.#abortTid)
    );
  }
}

function resource(type: string, id: number): WasmDebuggeeResourceRef {
  return { $res: type, id };
}
