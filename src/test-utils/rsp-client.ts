// A minimal RSP client used by integration tests to drive a running server.

import net from "node:net";
import { framePacket, PacketParser } from "../protocol/packet.js";

export class RspClient {
  #socket: net.Socket;
  #parser = new PacketParser();
  #responses: Buffer[] = [];
  #waiters: ((payload: Buffer) => void)[] = [];

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (data: Buffer) => {
      for (const item of this.#parser.feed(data)) {
        if (item.type !== "packet") continue;
        const waiter = this.#waiters.shift();
        if (waiter) waiter(item.payload);
        else this.#responses.push(item.payload);
      }
    });
  }

  static connect(port: number, host = "127.0.0.1"): Promise<RspClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () =>
        resolve(new RspClient(socket))
      );
      socket.once("error", reject);
    });
  }

  /** Send a packet and resolve with the next response payload. */
  request(data: string | Uint8Array): Promise<Buffer> {
    const promise = this.#next();
    this.#socket.write(framePacket(data));
    return promise;
  }

  /** Send a packet and resolve with the response decoded as latin1 text. */
  async requestText(data: string | Uint8Array): Promise<string> {
    return (await this.request(data)).toString("latin1");
  }

  #next(): Promise<Buffer> {
    const buffered = this.#responses.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    this.#socket.destroy();
  }
}
