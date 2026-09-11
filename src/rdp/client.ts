/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owns actor-local reply FIFOs and unsolicited event delivery. Non-event replies
// settle the actor's oldest request. Resume/interrupt use send(): their events
// must not leave request slots behind and shift subsequent reply correlation.

import { RdpTransport, type RdpPacket } from "./transport.js";
import { EVENTS, ROOT_ACTOR } from "./protocol.js";
import { EventEmitter } from "node:events";
import { noopLogger, type Logger } from "../diagnostics/logger.js";

// An interrupt ACK during a pause/transition is also an event, not the reply
// to an unrelated frames/source request. Keep it outside the actor FIFO.
const EVENT_TYPES = new Set<string>(Object.values(EVENTS));

interface Pending {
  id: number;
  method: string;
  started: number;
  resolve: (p: RdpPacket) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

export interface RdpRequestOptions {
  /** A timed-out actor FIFO cannot be resynchronized, so timeout closes the client. */
  timeoutMs?: number;
  /** Abort permanently retires this actor, discarding all its late replies.
   * Use only for actor lifetimes, never for a reusable actor's request deadline. */
  actorLifetime?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GREETING_TIMEOUT_MS = 10_000;

/** A Firefox reply error, distinct from transport loss or malformed framing. */
export class RdpRequestError extends Error {
  constructor(
    readonly actor: string,
    readonly method: string,
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "RdpRequestError";
  }
}

export class RdpClient extends EventEmitter {
  #transport: RdpTransport;
  #pending = new Map<string, Pending[]>();
  #retiredActors = new Set<string>();
  #ready: Promise<RdpPacket>;
  #requestTimeoutMs: number;
  #closed = false;
  #nextRequestId = 1;
  #pendingCount = 0;
  #failure?: Error;
  #logger: Logger;

  private constructor(
    transport: RdpTransport,
    requestTimeoutMs: number,
    signal?: AbortSignal,
    logger: Logger = noopLogger
  ) {
    super();
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#logger = logger;
    this.#record("connected");
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
      if (this.#retiredActors.has(from)) {
        this.#record("retired-actor-packet", { actor: from });
        return;
      }
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
        this.#pendingCount--;
        if (queue.length === 0) this.#pending.delete(from);
        clearTimeout(p.timer);
        p.removeAbort?.();
        this.#record("reply", {
          request: p.id,
          actor: from,
          method: p.method,
          elapsedMs: Math.round(performance.now() - p.started),
          outcome: packet.error ?? "ok",
        });
        if (packet.error)
          p.reject(new RdpRequestError(from, p.method, packet.error, packet.message ?? ""));
        else p.resolve(packet);
        return;
      }
      // Unsolicited packet with no matching request and no known event type.
      this.emit("unsolicited", packet);
    });
    transport.on("error", (e: Error) => {
      this.#failure ??= e;
      this.#record("failed", { error: e.message, ...this.pendingSnapshot() });
      this.#closed = true;
      rejectReady(e);
      this.#rejectPending(e);
      this.#transport.close();
      // During connect there may not be an external error listener yet. The
      // rejected ready promise is the observable error in that phase.
      // An owner-requested abort still rejects work and emits close, but is not
      // an unexpected transport failure for session/watcher error reporters.
      const cancelled = signal?.aborted && (e as NodeJS.ErrnoException).code === "ABORT_ERR";
      if (!cancelled && this.listenerCount("error") > 0) this.emit("error", e);
    });
    transport.on("close", () => {
      this.#closed = true;
      // Unblock the initial connect() if the root greeting never arrived.
      rejectReady(new Error("RDP connection closed before root greeting"));
      // Reject any in-flight requests so callers don't hang forever.
      this.#rejectPending(new Error("RDP connection closed"));
      this.#record("closed", { error: this.#failure?.message });
      this.emit("close");
    });
  }

  static async connect(
    port = 6080,
    host = "127.0.0.1",
    options: {
      requestTimeoutMs?: number;
      greetingTimeoutMs?: number;
      logger?: Logger;
      /** Aborting closes the whole connection; actor FIFO requests cannot be abandoned. */
      signal?: AbortSignal;
    } = {}
  ): Promise<RdpClient> {
    const transport = await RdpTransport.connect(port, host, options.logger, options.signal);
    const client = new RdpClient(
      transport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.signal,
      options.logger
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("RDP root greeting timeout")),
          options.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS
        );
      });
      await Promise.race([client.#ready, timeout]);
      options.signal?.throwIfAborted();
      return client;
    } catch (err) {
      client.close(err instanceof Error ? err : new Error(String(err)));
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
    if (this.#closed) return Promise.reject(this.#failure ?? new Error("RDP connection closed"));
    if (this.#retiredActors.has(to) || options.actorLifetime?.aborted)
      return Promise.reject(new Error(`RDP actor ${to} retired`));
    if (this.#pendingCount >= 1024) {
      const error = new Error("RDP connection closed: 1024 pending request limit");
      this.close(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let queue = this.#pending.get(to);
      if (!queue) this.#pending.set(to, (queue = []));
      const pending: Pending = {
        id: this.#nextRequestId++,
        method: String(packet.type ?? "unknown"),
        started: performance.now(),
        resolve,
        reject,
      };
      const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          const err = new Error(
            `RDP connection closed: request ${pending.id} ${to}.${pending.method} timed out after ${timeoutMs} ms`
          );
          // Actor replies are FIFO. Once one request times out, a late reply can
          // be mistaken for the next request, so the whole connection is unsafe.
          this.close(err);
        }, timeoutMs);
      }
      queue.push(pending);
      this.#pendingCount++;
      const lifetime = options.actorLifetime;
      if (lifetime) {
        const abort = () => this.#retireActor(to);
        lifetime.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => lifetime.removeEventListener("abort", abort);
      }
      this.#record("request", {
        request: pending.id,
        actor: to,
        method: pending.method,
        queueDepth: queue.length,
      });
      try {
        this.#transport.send({ ...packet, to });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Fire-and-forget send: transmit a packet without adding a pending-queue
   * entry. Use for packets whose response is an event (resume → "resumed",
   * interrupt → "paused") so we don't pollute the FIFO reply queue.
   */
  send(to: string, packet: Record<string, unknown>): void {
    if (this.#closed) throw new Error("RDP connection closed");
    if (this.#retiredActors.has(to)) throw new Error(`RDP actor ${to} retired`);
    try {
      this.#transport.send({ ...packet, to });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  close(error = new Error("RDP connection closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure ??= error;
    this.#record("closing", { error: error.message, ...this.pendingSnapshot() });
    this.#rejectPending(error);
    this.#transport.close();
  }

  #rejectPending(err: Error): void {
    for (const queue of this.#pending.values()) {
      for (const p of queue) {
        clearTimeout(p.timer);
        p.removeAbort?.();
        p.reject(err);
      }
    }
    this.#pending.clear();
    this.#pendingCount = 0;
  }

  #retireActor(actor: string): void {
    if (this.#retiredActors.has(actor) || this.#closed) return;
    if (this.#retiredActors.size >= 65536) {
      this.close(new Error("RDP retired actor limit exceeded (65536); reconnect required"));
      return;
    }
    this.#retiredActors.add(actor);
    const queue = this.#pending.get(actor) ?? [];
    this.#pending.delete(actor);
    this.#pendingCount -= queue.length;
    this.#record("actor-retired", { actor, requests: queue.map((request) => request.id) });
    for (const pending of queue) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(new Error(`RDP actor ${actor} retired`));
    }
  }

  pendingSnapshot(): { connection: number; count: number; requests: object[]; truncated: boolean } {
    const requests: object[] = [];
    for (const [actor, queue] of this.#pending) {
      for (const request of queue) {
        if (requests.length === 32) break;
        requests.push({
          request: request.id,
          actor,
          method: request.method,
          ageMs: Math.round(performance.now() - request.started),
          queueDepth: queue.length,
        });
      }
      if (requests.length === 32) break;
    }
    return {
      connection: this.#transport.connectionId,
      count: this.#pendingCount,
      requests,
      truncated: this.#pendingCount > requests.length,
    };
  }

  #record(event: string, detail: object = {}): void {
    this.#logger.debug(
      `[rdp-client] ${event} ${JSON.stringify({ connection: this.#transport.connectionId, ...detail })}`
    );
  }
}
