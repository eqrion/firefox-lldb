/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox RDP client: request/reply correlation per actor (FIFO) plus
// unsolicited event delivery.
//
// RDP rule: each actor processes requests serially, so a non-event packet from
// an actor is the reply to that actor's oldest outstanding request. Events are
// packets whose `type` is a known unsolicited notification (e.g. the watcher's
// "target-available-form", the thread's "paused"). Callers register event types
// they care about; everything else from an actor is treated as a reply.
//
// Important: resume and interrupt are sent as fire-and-forget (send(), not
// request()) because Firefox responds to them with "resumed"/"paused" events
// (in EVENT_TYPES), not with a pending-queue reply. Using request() for these
// would leave stale entries in the pending queue that corrupt subsequent replies.

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
  // Firefox sends {type:"interrupt"} as an ACK when a thread receives interrupt
  // while already paused or in a transition. Without this entry the packet is
  // routed to the per-actor FIFO pending queue, corrupting the next in-flight
  // request (e.g. wasmSources / frames) with garbage data and causing hangs.
  "interrupt",
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
    let rejectReady!: (e: Error) => void;
    this.#ready = new Promise((r, j) => {
      resolveReady = r;
      rejectReady = j;
    });
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
    transport.on("close", () => {
      this.emit("close");
      // Unblock the initial connect() if the root greeting never arrived.
      rejectReady(new Error("RDP connection closed before root greeting"));
      // Reject any in-flight requests so callers don't hang forever.
      const err = new Error("RDP connection closed");
      for (const queue of this.#pending.values()) {
        for (const p of queue) p.reject(err);
      }
      this.#pending.clear();
    });
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

  /**
   * Fire-and-forget send: transmit a packet without adding a pending-queue
   * entry. Use for packets whose response is an event (resume → "resumed",
   * interrupt → "paused") so we don't pollute the FIFO reply queue.
   */
  send(to: string, packet: Record<string, unknown>): void {
    this.#transport.send({ to, ...packet });
  }

  registerEventType(type: string): void {
    EVENT_TYPES.add(type);
  }

  close(): void {
    this.#transport.close();
  }
}
