/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from "node:fs/promises";
import { workerData } from "node:worker_threads";
import type { Logger } from "../logging.js";
import type { GdbRspConnection, GdbRspEndpoint, SourceDebuggerComponentHost } from "./component.js";
import { EmbeddedLldbComponentRuntime } from "./lldb-runtime.js";
import type {
  LldbIsolateControlRequest,
  LldbIsolateHostMessage,
  LldbIsolateOpenRspResponse,
  LldbIsolateWorkerData,
  LldbIsolateWorkerMessage,
} from "./lldb-isolate-protocol.js";
import { serveSourceDebuggerComponent } from "./rpc.js";
import { connectRspByteChannel } from "./rsp-byte-channel.js";

const data = workerData as LldbIsolateWorkerData;
const { componentPort, controlPort, options } = data;

function post(message: LldbIsolateHostMessage): void {
  controlPort.postMessage(message);
}

class IsolateSourceDebuggerComponentHost implements SourceDebuggerComponentHost {
  readonly #pending = new Map<
    number,
    { resolve: (connection: GdbRspConnection) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;
  #closed = false;

  connectGdbRsp(endpoint: GdbRspEndpoint): Promise<GdbRspConnection> {
    if (this.#closed) return Promise.reject(new Error("source debugger component host is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        post({ type: "lldb-isolate-open-rsp", id, endpoint });
      } catch (error) {
        this.#pending.delete(id);
        reject(toError(error));
      }
    });
  }

  handleResponse(response: LldbIsolateOpenRspResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      response.port?.close();
      return;
    }
    this.#pending.delete(response.id);
    if (response.error) {
      response.port?.close();
      pending.reject(deserializeError(response.error));
    } else if (response.port) pending.resolve(connectRspByteChannel(response.port));
    else pending.reject(new Error("component host returned no GDB RSP connection"));
  }

  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

const host = new IsolateSourceDebuggerComponentHost();
controlPort.on("close", () =>
  host.close(new Error("source debugger component host control port closed"))
);

const logger: Logger = {
  debug: options.verbose
    ? (message) => post({ type: "lldb-isolate-log", level: "debug", message })
    : () => {},
  info: (message) => post({ type: "lldb-isolate-log", level: "info", message }),
  warn: (message) => post({ type: "lldb-isolate-log", level: "warn", message }),
  error: (message) => post({ type: "lldb-isolate-log", level: "error", message }),
};

void (async () => {
  const runtime = await EmbeddedLldbComponentRuntime.create({
    host,
    id: options.id,
    name: options.name,
    logger,
    fileProvider: (path) => readFile(path).catch(() => null),
    observerResumesTarget: options.observerResumesTarget,
    exclusiveModules: options.exclusiveModules,
  });
  const componentEndpoint = serveSourceDebuggerComponent(componentPort, runtime.component);
  runtime.runControl.installSynchronizeStop?.((tid) =>
    post({ type: "lldb-isolate-synchronize-stop", ...(tid === undefined ? {} : { tid }) })
  );
  runtime.runControl.installAbortStop?.((tid) =>
    post({ type: "lldb-isolate-abort-stop", ...(tid === undefined ? {} : { tid }) })
  );

  const onMessage = (message: LldbIsolateWorkerMessage): void => {
    if (message.type === "lldb-isolate-open-rsp-response") {
      host.handleResponse(message);
      return;
    }
    if (message.type === "lldb-isolate-resume") {
      runtime.runControl.resume(message.action, (action) =>
        post({ type: "lldb-isolate-release", id: message.id, action })
      );
      return;
    }
    if (message.type !== "lldb-isolate-control-request") return;
    void handleControlRequest(runtime, message).then(
      (result) => {
        post({ type: "lldb-isolate-control-response", id: message.id, result });
        if (message.method === "close") {
          componentEndpoint.close();
          host.close(new Error("source debugger component host closed"));
          controlPort.off("message", onMessage);
          controlPort.close();
        }
      },
      (error) =>
        post({
          type: "lldb-isolate-control-response",
          id: message.id,
          error: serializeError(error),
        })
    );
  };

  controlPort.on("message", onMessage);
  controlPort.start();
  post({ type: "lldb-isolate-ready" });
})().catch((error) => {
  host.close(toError(error));
  post({ type: "lldb-isolate-initialization-error", error: serializeError(error) });
  componentPort.close();
  controlPort.close();
});

async function handleControlRequest(
  runtime: EmbeddedLldbComponentRuntime,
  request: LldbIsolateControlRequest
): Promise<unknown> {
  switch (request.method) {
    case "bridge-rsp":
      return runtime.bridgeRspEndpoint(request.args[0] as GdbRspEndpoint);
    case "connect-platform":
      return runtime.connectPlatform(request.args[0] as GdbRspEndpoint);
    case "probe-module":
      return runtime.probeModule(request.args[0] as Parameters<typeof runtime.probeModule>[0]);
    case "attach":
      return runtime.attach(request.args[0] as number, { attempts: request.args[1] as number });
    case "command":
      return runtime.command(request.args[0] as string);
    case "close":
      return runtime.close();
  }
}

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

function deserializeError(error: { name: string; message: string; stack?: string }): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
