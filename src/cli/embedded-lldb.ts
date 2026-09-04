/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import type { LLDBClient } from "lldb-wasm";
import type { Logger } from "../logging.js";

/** Bridges the TCP RSP servers in this process to lldb-wasm channels. */
export class EmbeddedLldbBridge {
  readonly #client: LLDBClient;
  readonly #logger: Logger;
  readonly #sockets = new Set<net.Socket>();

  constructor(client: LLDBClient, logger: Logger) {
    this.#client = client;
    this.#logger = logger;
  }

  async bridgeTcp(port: number): Promise<number> {
    const channelId = await this.#client.createChannel();
    const socket = net.connect(port, "127.0.0.1");
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.setNoDelay(true);

    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("data", (data) => {
      this.#logger.debug(
        `[bridge channel ${channelId}] server-to-LLDB queued ${data.length} bytes`
      );
      void this.#client
        .channelServerWrite(channelId, new Uint8Array(data))
        .then((written) => {
          this.#logger.debug(
            `[bridge channel ${channelId}] server-to-LLDB accepted ${written}/${data.length} bytes`
          );
        })
        .catch((error) => {
          this.#logger.error(
            `[bridge] server-to-LLDB write failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          socket.destroy();
        });
    });
    socket.on("error", (error) => this.#logger.warn(`[bridge] socket error: ${error.message}`));
    await this.#client.bridgeChannel(channelId, (data) => void socket.write(Buffer.from(data)));
    await connected;
    return channelId;
  }

  close(): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}
