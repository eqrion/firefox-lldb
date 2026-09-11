/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import type { LLDBClient } from "lldb-wasm";
import type { Logger } from "../diagnostics/logger.js";
import { RspTrace } from "../diagnostics/rsp-trace.js";

type ChannelClient = Pick<
  LLDBClient,
  "createChannel" | "bridgeChannel" | "channelServerWrite" | "destroyChannel"
>;

/** Owns both transport ends, including channels still being created. */
export class EmbeddedLldbBridge {
  readonly #connections = new Set<BridgedConnection>();
  #serial = 0;
  #closing?: Promise<void>;
  #failure?: string;
  #resolveFailure!: (error: Error) => void;
  /** First channel failure, including failures while LLDB is idle. */
  readonly failed = new Promise<Error>((resolve) => {
    this.#resolveFailure = resolve;
  });

  constructor(
    private readonly client: ChannelClient,
    private readonly logger: Logger
  ) {}

  async bridgeTcp(port: number, label = `tab-${++this.#serial}`): Promise<number> {
    if (this.#closing) throw new Error("embedded bridge is closed");
    const connection = new BridgedConnection(this.client, this.logger, port, label, (error) => {
      this.#failure ??= error.message;
      this.#resolveFailure(error);
    });
    this.#connections.add(connection);
    // Keep ownership until channel destruction completes, not just TCP close.
    void connection.closed.then(() => {
      this.#failure ??= connection.failure;
      this.#connections.delete(connection);
    });
    try {
      return await connection.ready;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  logState(): void {
    for (const connection of this.#connections) connection.logState();
  }

  /** Preserve transport failure evidence even after its connection is retired. */
  get failure(): string | undefined {
    return this.#failure ?? [...this.#connections].find((c) => c.failure)?.failure;
  }

  /** On timeout the owner must destroy LLDBClient to cancel its pending RPCs. */
  close(timeoutMs = 5000): Promise<void> {
    if (this.#closing) return this.#closing;
    const cleanup = Promise.all([...this.#connections].map((connection) => connection.close()));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.logState();
        reject(
          new Error(
            `embedded bridge cleanup timed out after ${timeoutMs} ms; destroy LLDBClient to cancel pending channel work`
          )
        );
      }, timeoutMs);
    });
    this.#closing = Promise.race([cleanup, timeout])
      .then(() => {})
      .finally(() => clearTimeout(timer));
    return this.#closing;
  }
}

/** One TCP socket, one LLDB channel, one ordered incoming write at a time. */
class BridgedConnection {
  readonly ready: Promise<number>;
  readonly closed: Promise<void>;
  #resolveClosed!: () => void;
  #channelId?: number;
  #socket?: net.Socket;
  #closing?: Promise<void>;
  #stopped = false;
  #state = "creating";
  #writes: Promise<void> = Promise.resolve();
  #registration?: Promise<void>;
  #sentBytes = 0;
  #receivedBytes = 0;
  #acceptedBytes = 0;
  #pendingWrites = 0;
  #lastActivity = performance.now();
  #lastError = "none";
  readonly #sent: RspTrace;
  readonly #received: RspTrace;

  constructor(
    private readonly client: ChannelClient,
    private readonly logger: Logger,
    port: number,
    private readonly label: string,
    private readonly onFailure: (error: Error) => void
  ) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#sent = new RspTrace((packet) => this.#record(`LLDB->TCP RSP ${packet}`));
    this.#received = new RspTrace((packet) => this.#record(`TCP->LLDB RSP ${packet}`));
    this.ready = this.#connect(port);
  }

  #record(message: string): void {
    this.logger.debug(`[bridge ${this.label}] ${message}`);
  }

  get failure(): string | undefined {
    return this.#lastError === "none" ? undefined : this.#lastError;
  }

  logState(): void {
    this.#record(
      `channel=${this.#channelId ?? "pending"} tcp=${this.#state} ` +
        `LLDB->TCP=${this.#sentBytes} bytes TCP->LLDB=${this.#receivedBytes} bytes ` +
        `accepted=${this.#acceptedBytes} pending-writes=${this.#pendingWrites} ` +
        `tcp-buffered=${this.#socket?.writableLength ?? 0} ` +
        `idle=${Math.round(performance.now() - this.#lastActivity)}ms error=${this.#lastError}`
    );
    this.#record(`last LLDB->TCP RSP ${this.#sent.lastPacket}`);
    this.#record(`last TCP->LLDB RSP ${this.#received.lastPacket}`);
  }

  #fail(error: unknown): void {
    this.#lastError = error instanceof Error ? error.message : String(error);
    this.logger.warn(`[bridge ${this.label}] ${this.#lastError}`);
    void this.close();
    this.onFailure(error instanceof Error ? error : new Error(String(error)));
  }

  async #connect(port: number): Promise<number> {
    this.#record(`creating LLDB channel for TCP port ${port}`);
    this.#channelId = await this.client.createChannel();
    if (this.#stopped) throw new Error("embedded bridge closed during channel creation");
    const channelId = this.#channelId;
    const socket = (this.#socket = net.connect(port, "127.0.0.1"));
    socket.setNoDelay(true);
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => {
      this.#state = "closed";
      this.#record("TCP closed");
      void this.close();
    });
    socket.on("data", (data) => {
      if (this.#stopped) return;
      socket.pause();
      this.#receivedBytes += data.length;
      this.#lastActivity = performance.now();
      this.#received.feed(data);
      this.#pendingWrites++;
      this.#writes = this.#writes
        .then(async () => {
          const written = await this.client.channelServerWrite(channelId, new Uint8Array(data));
          this.#acceptedBytes += written;
          if (written !== data.length)
            throw new Error(`TCP->LLDB partial write: accepted ${written}/${data.length} bytes`);
        })
        .catch((error) => this.#fail(error))
        .finally(() => {
          this.#pendingWrites--;
          if (!this.#stopped) socket.resume();
        });
    });

    // Observe connection failure immediately, even while drain registration is
    // pending. Waiting for these sequentially can leave a rejection unhandled.
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("TCP connect timed out after 10000 ms")),
        10_000
      );
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => onError(new Error("TCP closed during bridge setup"));
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    this.#registration = this.client.bridgeChannel(channelId, (data) => {
      if (this.#stopped) return;
      this.#sentBytes += data.length;
      this.#lastActivity = performance.now();
      this.#sent.feed(data);
      if (socket.writableLength + data.length > 4 * 1024 * 1024) {
        this.#fail(new Error("LLDB->TCP queued output exceeds 4 MiB"));
        return;
      }
      socket.write(data);
    });
    await Promise.all([connected, this.#registration]);
    if (this.#stopped) throw new Error("embedded bridge closed during setup");
    this.#state = "connected";
    this.#record(`active channel=${channelId} port=${port}`);
    return channelId;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#stopped = true;
    this.#socket?.destroy();
    this.#closing = (async () => {
      await this.ready.catch(() => {});
      await this.#registration?.catch(() => {});
      // Deliver an already-received final reply before marking the channel EOF.
      await this.#writes;
      if (this.#channelId !== undefined) {
        try {
          await this.client.destroyChannel(this.#channelId);
        } catch (error) {
          this.#lastError = `channel cleanup failed: ${String(error)}`;
          this.logger.warn(`[bridge ${this.label}] ${this.#lastError}`);
        }
      }
      this.#state = "closed";
      this.logState();
      this.#resolveClosed();
    })();
    return this.#closing;
  }
}
