// Firefox Remote Debug Protocol transport: length-prefixed JSON packets over a
// TCP socket. Wire format is `<utf8-byte-length>:<json>` (see Firefox
// devtools/shared/transport/packets.js).

import net from "node:net";
import { EventEmitter } from "node:events";

export interface RdpPacket {
  from?: string;
  type?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export class RdpTransport extends EventEmitter {
  #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(socket: net.Socket) {
    super();
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }

  static connect(port: number, host = "127.0.0.1"): Promise<RdpTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () =>
        resolve(new RdpTransport(socket))
      );
      socket.once("error", reject);
    });
  }

  send(packet: RdpPacket): void {
    const json = Buffer.from(JSON.stringify(packet), "utf8");
    this.#socket.write(`${json.length}:`);
    this.#socket.write(json);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a); // ':'
      if (colon === -1) {
        if (this.#buffer.length > 20) this.emit("error", new Error("malformed length prefix"));
        return;
      }
      const len = parseInt(this.#buffer.subarray(0, colon).toString("latin1"), 10);
      if (Number.isNaN(len)) {
        this.emit("error", new Error("invalid packet length"));
        return;
      }
      const start = colon + 1;
      if (this.#buffer.length < start + len) return; // wait for the full body
      const body = this.#buffer.subarray(start, start + len).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + len);
      try {
        this.emit("packet", JSON.parse(body) as RdpPacket);
      } catch (err) {
        this.emit("error", err as Error);
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}
