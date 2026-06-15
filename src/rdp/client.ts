// Firefox RDP client: request/reply correlation per actor (FIFO) plus
// unsolicited event delivery.
//
// RDP rule: each actor processes requests serially, so a non-event packet from
// an actor is the reply to that actor's oldest outstanding request. Events are
// packets whose `type` is a known unsolicited notification (e.g. the watcher's
// "target-available-form", the thread's "paused"). Callers register event types
// they care about; everything else from an actor is treated as a reply.

import { RdpTransport, type RdpPacket } from "./transport.js";
import { EventEmitter } from "node:events";

// Unsolicited notification types (never treated as request replies).
const EVENT_TYPES = new Set([
  "target-available-form",
  "target-destroyed-form",
  "resource-available-form",
  "resource-updated-form",
  "resource-destroyed-form",
  "tabNavigated",
  "tabDetached",
  "frameUpdate",
  "paused",
  "resumed",
  "newSource",
  "willNavigate",
  "networkEvent",
]);

interface Pending {
  resolve: (p: RdpPacket) => void;
  reject: (e: Error) => void;
}

export class RdpClient extends EventEmitter {
  #transport: RdpTransport;
  #pending = new Map<string, Pending[]>();
  #ready: Promise<RdpPacket>;

  private constructor(transport: RdpTransport) {
    super();
    this.#transport = transport;
    let resolveReady!: (p: RdpPacket) => void;
    this.#ready = new Promise((r) => (resolveReady = r));
    let gotRoot = false;

    transport.on("packet", (packet: RdpPacket) => {
      const from = packet.from;
      if (!from) return;
      if (from === "root" && !gotRoot) {
        gotRoot = true;
        resolveReady(packet);
        return;
      }
      if (packet.type && EVENT_TYPES.has(packet.type)) {
        this.emit("event", packet);
        this.emit(`${from}:${packet.type}`, packet);
        return;
      }
      const queue = this.#pending.get(from);
      if (queue && queue.length) {
        const p = queue.shift()!;
        if (packet.error) p.reject(new Error(`${packet.error}: ${packet.message ?? ""}`));
        else p.resolve(packet);
        return;
      }
      // Unsolicited packet with no matching request and no known event type.
      this.emit("unsolicited", packet);
    });
    transport.on("error", (e) => this.emit("error", e));
    transport.on("close", () => this.emit("close"));
  }

  static async connect(port = 6080, host = "127.0.0.1"): Promise<RdpClient> {
    const transport = await RdpTransport.connect(port, host);
    const client = new RdpClient(transport);
    await client.#ready; // wait for the root greeting
    return client;
  }

  /** Send a request to an actor and resolve with its reply. */
  request(to: string, packet: Record<string, unknown> = {}): Promise<RdpPacket> {
    return new Promise((resolve, reject) => {
      let queue = this.#pending.get(to);
      if (!queue) this.#pending.set(to, (queue = []));
      queue.push({ resolve, reject });
      this.#transport.send({ to, ...packet });
    });
  }

  /** Resolve the next occurrence of an event key (`<actor>:<type>`). */
  waitForEvent(eventKey: string): Promise<RdpPacket> {
    return new Promise((resolve) => super.once(eventKey, resolve));
  }

  registerEventType(type: string): void {
    EVENT_TYPES.add(type);
  }

  close(): void {
    this.#transport.close();
  }
}
