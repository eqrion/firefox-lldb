/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parentPort, workerData } from "node:worker_threads";
import { connectSourceDebuggerComponentHost } from "../../transport/host-rpc.js";
import { serveSourceDebuggerComponentIsolate } from "../../transport/isolate.js";
import { WasmSourceDebuggerComponent } from "./component.js";
import type { WasmTextIsolateMessage, WasmTextIsolateWorkerData } from "./isolate-protocol.js";

const data = workerData as WasmTextIsolateWorkerData;
const { componentPort, hostPort, options } = data;
const parent = parentPort;
if (!parent) throw new Error("Wasm text isolate has no parent port");

const post = (message: WasmTextIsolateMessage): void => parent.postMessage(message);
const host = connectSourceDebuggerComponentHost(hostPort, { requestTimeoutMs: 30_000 });
parent.on("close", () => host.close());

void (async () => {
  const debuggee = await host.openWasmDebuggee();
  const component = new WasmSourceDebuggerComponent(debuggee, options.id, options.name);
  serveSourceDebuggerComponentIsolate({ componentPort }, component);
  post({ type: "wasm-text-isolate-ready" });
})().catch((error) => {
  host.close();
  post({ type: "wasm-text-isolate-initialization-error", error: serializeError(error) });
  componentPort.close();
  parent.close();
});

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
