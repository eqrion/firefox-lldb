// A generic GDB-remote-serial-protocol TCP server.
//
// This is the transport shared by both layers of the bridge: the platform
// server and the per-tab GDB server. It owns socket I/O, packet framing, and
// ack/no-ack bookkeeping, and delegates packet payloads to an RspHandler.

import net from "node:net";
import { PacketParser, framePacket } from "./packet.js";

export interface RspHandler {
  /**
   * Handle one packet payload. Return the response payload (string or raw
   * bytes), an empty string for "unsupported", or null to send no immediate
   * response (e.g. continue/step, whose reply is a later async stop packet).
   */
  handle(payload: Buffer, session: RspSession): Promise<Uint8Array | string | null>;
  /** Handle a Ctrl-C (0x03) interrupt request. */
  interrupt?(session: RspSession): void | Promise<void>;
  onConnect?(session: RspSession): void;
  onDisconnect?(session: RspSession): void;
}

export interface RspLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: RspLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** One client connection. Created by RspServer for each accepted socket. */
export class RspSession {
  #socket: net.Socket;
  #parser = new PacketParser();
  #handler: RspHandler;
  #log: RspLogger;
  #noAck = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(socket: net.Socket, handler: RspHandler, log: RspLogger) {
    this.#socket = socket;
    this.#handler = handler;
    this.#log = log;

    socket.on("data", (data: Buffer) => this.#onData(data));
    socket.on("close", () => this.#handler.onDisconnect?.(this));
    socket.on("error", (err) => this.#log.warn(`socket error: ${err.message}`));

    this.#handler.onConnect?.(this);
  }

  get noAckMode(): boolean {
    return this.#noAck;
  }

  setNoAckMode(on: boolean): void {
    this.#noAck = on;
  }

  /** Send a framed packet (used for responses and async notifications). */
  send(payload: Uint8Array | string): void {
    const printable = typeof payload === "string" ? payload : "<binary>";
    this.#log.debug(`>> ${truncate(printable)}`);
    this.#socket.write(framePacket(payload));
  }

  #sendRaw(byte: string): void {
    this.#socket.write(byte);
  }

  #onData(data: Buffer): void {
    // Serialize handling so async handlers reply in packet order.
    this.#queue = this.#queue.then(() => this.#process(data));
  }

  async #process(data: Buffer): Promise<void> {
    for (const item of this.#parser.feed(data)) {
      switch (item.type) {
        case "ack":
        case "nack":
          break;
        case "interrupt":
          this.#log.debug("<< interrupt");
          await this.#handler.interrupt?.(this);
          break;
        case "packet": {
          if (!item.valid) {
            this.#log.warn("<< bad checksum");
            if (!this.#noAck) this.#sendRaw("-");
            break;
          }
          if (!this.#noAck) this.#sendRaw("+");
          const text = item.payload.toString("latin1");
          this.#log.debug(`<< ${truncate(text)}`);
          try {
            const response = await this.#handler.handle(item.payload, this);
            if (response !== null) this.send(response);
          } catch (err) {
            this.#log.error(`handler error: ${(err as Error).message}`);
            this.send("E01");
          }
          break;
        }
      }
    }
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** A TCP server that hands each accepted connection to an RspHandler. */
export class RspServer {
  #server: net.Server;
  #log: RspLogger;
  #port = 0;

  constructor(
    handlerFactory: () => RspHandler,
    options: { logger?: RspLogger; singleConnection?: boolean } = {}
  ) {
    this.#log = options.logger ?? noopLogger;
    let active: RspSession | null = null;

    this.#server = net.createServer((socket) => {
      if (options.singleConnection && active) {
        this.#log.warn("rejecting second connection");
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      this.#log.info("client connected");
      const session = new RspSession(socket, handlerFactory(), this.#log);
      active = session;
      socket.on("close", () => {
        if (active === session) active = null;
        this.#log.info("client disconnected");
      });
    });
  }

  /** Begin listening. Port 0 auto-selects. Resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        const addr = this.#server.address();
        this.#port = typeof addr === "object" && addr ? addr.port : port;
        this.#log.info(`listening on ${host}:${this.#port}`);
        resolve(this.#port);
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

function truncate(str: string, max = 200): string {
  return str.length <= max ? str : `${str.slice(0, max)}... (${str.length} chars)`;
}
