/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { noopLogger, type Logger } from "../logging.js";
import type { GdbRspConnection } from "./component.js";

export type RspByteChannelMessage = { type: "rsp-data"; data: Uint8Array } | { type: "rsp-close" };

/** Host-owned half of one GDB RSP byte stream. The transferable componentPort
 * is the capability handed to an isolated debugger; the TCP socket never
 * crosses that boundary. */
export interface HostRspByteChannel {
  componentPort: MessagePort;
  closed: Promise<void>;
  close(): void;
}

export async function openTcpRspByteChannel(
  tcpPort: number,
  options: { logger?: Logger; label?: string } = {}
): Promise<HostRspByteChannel> {
  const logger = options.logger ?? noopLogger;
  const label = options.label ?? "RSP";
  const channel = new MessageChannel();
  const socket = net.connect(tcpPort, "127.0.0.1");
  socket.setNoDelay(true);

  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = (notifyComponent: boolean): void => {
    if (closed) return;
    closed = true;
    if (notifyComponent) {
      try {
        channel.port1.postMessage({ type: "rsp-close" } satisfies RspByteChannelMessage);
      } catch {
        // The component already closed or transferred away its endpoint.
      }
    }
    channel.port1.close();
    socket.destroy();
    resolveClosed();
  };

  channel.port1.on("message", (message: RspByteChannelMessage) => {
    if (message.type === "rsp-data") {
      if (!socket.destroyed) socket.write(Buffer.from(message.data));
    } else if (message.type === "rsp-close") {
      close(false);
    }
  });
  channel.port1.on("messageerror", () => close(false));
  channel.port1.on("close", () => close(false));
  channel.port1.start();

  socket.on("data", (data) => {
    if (!closed) {
      channel.port1.postMessage({
        type: "rsp-data",
        data: new Uint8Array(data),
      } satisfies RspByteChannelMessage);
    }
  });
  socket.on("error", (error) => {
    logger.warn(`[${label}] TCP bridge error: ${error.message}`);
  });
  socket.on("close", () => close(true));

  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    await connected;
  } catch (error) {
    close(true);
    throw error;
  }

  return {
    componentPort: channel.port2,
    closed: closedPromise,
    close: () => close(true),
  };
}

/** Component-side adapter for the transferable byte channel. The resulting
 * pull-based resource is independent of MessagePort and is the shape exposed
 * by SourceDebuggerComponentHost. */
export function connectRspByteChannel(port: MessagePort): GdbRspConnection {
  const chunks: Uint8Array[] = [];
  const readers: Array<(data: Uint8Array | null) => void> = [];
  let ended = false;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const resolve of readers.splice(0)) resolve(null);
  };

  port.on("message", (message: RspByteChannelMessage) => {
    if (message.type === "rsp-close") {
      finish();
      port.close();
      return;
    }
    const reader = readers.shift();
    if (reader) reader(message.data);
    else chunks.push(message.data);
  });
  port.on("messageerror", finish);
  port.on("close", finish);
  port.start();

  return {
    read(): Promise<Uint8Array | null> {
      const chunk = chunks.shift();
      if (chunk) return Promise.resolve(chunk);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => readers.push(resolve));
    },
    async write(data: Uint8Array): Promise<void> {
      if (ended) throw new Error("GDB RSP connection is closed");
      port.postMessage({ type: "rsp-data", data } satisfies RspByteChannelMessage);
    },
    async close(): Promise<void> {
      if (ended) return;
      try {
        port.postMessage({ type: "rsp-close" } satisfies RspByteChannelMessage);
      } finally {
        finish();
        port.close();
      }
    },
  };
}
