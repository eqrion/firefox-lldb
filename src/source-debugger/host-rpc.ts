/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessagePort } from "node:worker_threads";
import type { GdbRspConnection, GdbRspEndpoint, SourceDebuggerComponentHost } from "./component.js";
import type { SourceDebuggerComponentHostBinding } from "./host.js";
import { connectRspByteChannel } from "./rsp-byte-channel.js";
import type { SourceDebuggerRpcEndpoint } from "./rpc.js";

interface HostRequest {
  type: "source-debugger-host-request";
  id: number;
  endpoint: GdbRspEndpoint;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface HostResponse {
  type: "source-debugger-host-response";
  id: number;
  port?: MessagePort;
  error?: SerializedError;
}

interface PendingHostCall {
  resolve: (connection: GdbRspConnection) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export type RemoteSourceDebuggerComponentHost = SourceDebuggerComponentHost &
  SourceDebuggerRpcEndpoint;

export function serveSourceDebuggerComponentHost(
  port: MessagePort,
  host: SourceDebuggerComponentHostBinding
): SourceDebuggerRpcEndpoint {
  let closed = false;
  const onMessage = (message: unknown): void => {
    if (!isRequest(message)) return;
    void host.openGdbRspChannel(message.endpoint).then(
      (channel) => {
        if (closed) {
          channel.close();
          return;
        }
        try {
          port.postMessage(
            {
              type: "source-debugger-host-response",
              id: message.id,
              port: channel.componentPort,
            } satisfies HostResponse,
            [channel.componentPort]
          );
        } catch {
          channel.close();
        }
      },
      (error) => {
        try {
          if (!closed) {
            port.postMessage({
              type: "source-debugger-host-response",
              id: message.id,
              error: serializeError(error),
            } satisfies HostResponse);
          }
        } catch {
          // The isolate closed while an asynchronous host call was settling.
        }
      }
    );
  };
  port.on("message", onMessage);
  port.start();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      port.off("message", onMessage);
      port.close();
    },
  };
}

export function connectSourceDebuggerComponentHost(
  port: MessagePort,
  options: { requestTimeoutMs?: number } = {}
): RemoteSourceDebuggerComponentHost {
  const timeoutMs = options.requestTimeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("SourceDebuggerComponent host RPC timeout must be a positive number");
  }
  const pending = new Map<number, PendingHostCall>();
  let nextId = 1;
  let closed = false;

  const rejectPending = (error: Error): void => {
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };
  const close = (error = new Error("SourceDebuggerComponent host RPC closed")): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    port.off("close", onClose);
    port.close();
    rejectPending(error);
  };
  const onMessage = (message: unknown): void => {
    if (!isResponse(message)) return;
    const call = pending.get(message.id);
    if (!call) {
      message.port?.close();
      return;
    }
    pending.delete(message.id);
    if (call.timer) clearTimeout(call.timer);
    if (message.error) {
      message.port?.close();
      call.reject(deserializeError(message.error));
    } else if (message.port) call.resolve(connectRspByteChannel(message.port));
    else call.reject(new Error("SourceDebuggerComponent host returned no GDB RSP connection"));
  };
  const onClose = (): void => close(new Error("SourceDebuggerComponent host RPC peer closed"));
  port.on("message", onMessage);
  port.on("close", onClose);
  port.start();

  return {
    connectGdbRsp(endpoint: GdbRspEndpoint): Promise<GdbRspConnection> {
      if (closed) return Promise.reject(new Error("SourceDebuggerComponent host RPC is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const call: PendingHostCall = { resolve, reject };
        if (timeoutMs !== undefined) {
          call.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(
              new Error(
                `SourceDebuggerComponent host RPC connectGdbRsp timed out after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
        }
        pending.set(id, call);
        try {
          port.postMessage({
            type: "source-debugger-host-request",
            id,
            endpoint,
          } satisfies HostRequest);
        } catch (error) {
          pending.delete(id);
          if (call.timer) clearTimeout(call.timer);
          reject(toError(error));
        }
      });
    },
    close: () => close(),
  };
}

function isRequest(message: unknown): message is HostRequest {
  if (!message || typeof message !== "object") return false;
  const request = message as Partial<HostRequest>;
  return (
    request.type === "source-debugger-host-request" &&
    typeof request.id === "number" &&
    !!request.endpoint &&
    typeof request.endpoint.id === "string" &&
    (request.endpoint.kind === "platform" || request.endpoint.kind === "process")
  );
}

function isResponse(message: unknown): message is HostResponse {
  if (!message || typeof message !== "object") return false;
  const response = message as Partial<HostResponse>;
  return response.type === "source-debugger-host-response" && typeof response.id === "number";
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(error: SerializedError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
