/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from "node:fs/promises";
import { workerData } from "node:worker_threads";
import type { Logger } from "../logging.js";
import { EmbeddedLldbComponentRuntime } from "./lldb-runtime.js";
import type {
  LldbIsolateControlRequest,
  LldbIsolateHostMessage,
  LldbIsolateWorkerData,
  LldbIsolateWorkerMessage,
} from "./lldb-isolate-protocol.js";
import { serveSourceDebuggerComponent } from "./rpc.js";

const data = workerData as LldbIsolateWorkerData;
const { componentPort, controlPort, options } = data;

function post(message: LldbIsolateHostMessage): void {
  controlPort.postMessage(message);
}

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
    id: options.id,
    name: options.name,
    logger,
    fileProvider: (path) => readFile(path).catch(() => null),
    observerResumesTarget: options.observerResumesTarget,
    exclusiveModules: options.exclusiveModules,
  });
  const componentEndpoint = serveSourceDebuggerComponent(componentPort, runtime.component);
  runtime.runControl.installSynchronizeStop?.(() =>
    post({ type: "lldb-isolate-synchronize-stop" })
  );
  runtime.runControl.installAbortStop?.(() => post({ type: "lldb-isolate-abort-stop" }));

  const onMessage = (message: LldbIsolateWorkerMessage): void => {
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
  post({ type: "lldb-isolate-initialization-error", error: serializeError(error) });
  componentPort.close();
  controlPort.close();
});

async function handleControlRequest(
  runtime: EmbeddedLldbComponentRuntime,
  request: LldbIsolateControlRequest
): Promise<unknown> {
  switch (request.method) {
    case "bridge-tcp":
      return runtime.bridgeTcp(request.args[0] as number);
    case "connect-platform":
      return runtime.connectPlatform(request.args[0] as number);
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
