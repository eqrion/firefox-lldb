/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Firefox RDP client: request/reply correlation per actor (FIFO) plus
// unsolicited event delivery.
//
// RDP rule: each actor processes requests serially, so a non-event packet from
// an actor is the reply to that actor's oldest outstanding request. Events are
// packets whose `type` is a known unsolicited notification (e.g. the watcher's
// "target-available-form", the thread's "paused") — see EVENTS in protocol.ts
// for the full catalog. Everything else from an actor is treated as a reply.
//
// Important: resume and interrupt are sent as fire-and-forget (send(), not
// request()) because Firefox responds to them with "resumed"/"paused" events,
// not with a pending-queue reply. Using request() for these would leave stale
// entries in the pending queue that corrupt subsequent replies.

import { RdpTransport, type RdpPacket } from "./transport.js";
import { EVENTS, ROOT_ACTOR } from "./protocol.js";
import { EventEmitter } from "node:events";
import type { Logger } from "../logging.js";

// Unsolicited notification types (never treated as request replies). Firefox
// sends {type:"interrupt"} as an ACK when a thread receives interrupt while
// already paused or in a transition; without it in this set the packet is
// routed to the per-actor FIFO pending queue, corrupting the next in-flight
// request (e.g. wasmSources / frames) with garbage data and causing hangs.
const EVENT_TYPES = new Set<string>(Object.values(EVENTS));

interface Pending {
  resolve: (p: RdpPacket) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RdpRequestOptions {
  /** A timed-out actor FIFO cannot be resynchronized, so timeout closes the client. */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GREETING_TIMEOUT_MS = 10_000;

export class RdpClient extends EventEmitter {
  #transport: RdpTransport;
  #pending = new Map<string, Pending[]>();
  #ready: Promise<RdpPacket>;
  #requestTimeoutMs: number;
  #closed = false;

  private constructor(transport: RdpTransport, requestTimeoutMs: number) {
    super();
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;
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
      if (from === ROOT_ACTOR && !gotRoot) {
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
        if (queue.length === 0) this.#pending.delete(from);
        clearTimeout(p.timer);
        if (packet.error) p.reject(new Error(`${packet.error}: ${packet.message ?? ""}`));
        else p.resolve(packet);
        return;
      }
      // Unsolicited packet with no matching request and no known event type.
      this.emit("unsolicited", packet);
    });
    transport.on("error", (e: Error) => {
      this.#closed = true;
      rejectReady(e);
      this.#rejectPending(e);
      this.#transport.close();
      // During connect there may not be an external error listener yet. The
      // rejected ready promise is the observable error in that phase.
      if (this.listenerCount("error") > 0) this.emit("error", e);
    });
    transport.on("close", () => {
      this.#closed = true;
      this.emit("close");
      // Unblock the initial connect() if the root greeting never arrived.
      rejectReady(new Error("RDP connection closed before root greeting"));
      // Reject any in-flight requests so callers don't hang forever.
      this.#rejectPending(new Error("RDP connection closed"));
    });
  }

  static async connect(
    port = 6080,
    host = "127.0.0.1",
    options: { requestTimeoutMs?: number; greetingTimeoutMs?: number; logger?: Logger } = {}
  ): Promise<RdpClient> {
    const transport = await RdpTransport.connect(port, host, options.logger);
    const client = new RdpClient(transport, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("RDP root greeting timeout")),
          options.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS
        );
      });
      await Promise.race([client.#ready, timeout]);
      return client;
    } catch (err) {
      client.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a request to an actor and resolve with its reply. */
  request(
    to: string,
    packet: Record<string, unknown> = {},
    options: RdpRequestOptions = {}
  ): Promise<RdpPacket> {
    if (this.#closed) return Promise.reject(new Error("RDP connection closed"));
    return new Promise((resolve, reject) => {
      let queue = this.#pending.get(to);
      if (!queue) this.#pending.set(to, (queue = []));
      const pending: Pending = { resolve, reject };
      const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          const err = new Error(`RDP request to ${to} timed out after ${timeoutMs} ms`);
          pending.reject(err);
          // Actor replies are FIFO. Once one request times out, a late reply can
          // be mistaken for the next request, so the whole connection is unsafe.
          this.close();
        }, timeoutMs);
      }
      queue.push(pending);
      this.#transport.send({ to, ...packet });
    });
  }

  /**
   * Fire-and-forget send: transmit a packet without adding a pending-queue
   * entry. Use for packets whose response is an event (resume → "resumed",
   * interrupt → "paused") so we don't pollute the FIFO reply queue.
   */
  send(to: string, packet: Record<string, unknown>): void {
    if (this.#closed) throw new Error("RDP connection closed");
    this.#transport.send({ to, ...packet });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("RDP connection closed"));
    this.#transport.close();
  }

  #rejectPending(err: Error): void {
    for (const queue of this.#pending.values()) {
      for (const p of queue) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
    this.#pending.clear();
  }
}
