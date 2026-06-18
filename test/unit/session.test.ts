/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unit tests for RdpWasmSession: multi-thread target management,
// all-stop coordination, and breakpoint buffering. Uses a lightweight
// fake RDP server so no real Firefox is required.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RdpWasmSession, type StoppedEvent, type PauseEvent } from "../../src/rdp/session.js";

// ---------------------------------------------------------------------------
// Fake RDP server
// ---------------------------------------------------------------------------

function encode(packet: object): Buffer {
  const json = Buffer.from(JSON.stringify(packet), "utf8");
  return Buffer.concat([Buffer.from(`${json.length}:`, "utf8"), json]);
}

function decodeAll(buf: Buffer): { packets: Record<string, unknown>[]; rest: Buffer } {
  const packets: Record<string, unknown>[] = [];
  for (;;) {
    const colon = buf.indexOf(0x3a);
    if (colon === -1) break;
    const len = parseInt(buf.subarray(0, colon).toString(), 10);
    if (isNaN(len) || len < 0) break;
    const start = colon + 1;
    if (buf.length < start + len) break;
    packets.push(JSON.parse(buf.subarray(start, start + len).toString("utf8")));
    buf = buf.subarray(start + len);
  }
  return { packets, rest: buf };
}

type ReqPacket = Record<string, unknown>;
type HandlerFn = (req: ReqPacket) => object | null;

/**
 * Minimal fake Firefox RDP server.
 *
 * - Handles the `RdpWasmSession` init handshake automatically.
 * - Remaining requests are dispatched to registered handlers in registration
 *   order; the first match wins.
 * - `send(packet)` injects an unsolicited event into the session.
 */
class FakeRdpServer {
  private srv: net.Server;
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private handlers: Array<{ match: (r: ReqPacket) => boolean; handle: HandlerFn }> = [];
  readonly received: ReqPacket[] = [];
  private pendingConnect: (() => void) | null = null;
  port = 0;

  constructor() {
    this.srv = net.createServer((s) => {
      this.sock = s;
      this.pendingConnect?.();
      s.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        const { packets, rest } = decodeAll(this.buf);
        this.buf = rest as Buffer<ArrayBuffer>;
        for (const pkt of packets) {
          this.received.push(pkt);
          this.#dispatch(pkt);
        }
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.srv.listen(0, "127.0.0.1", () => {
        this.port = (this.srv.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  /** Wait for a client connection, send the root greeting, handle the
   * session init sequence, then return the live session. */
  async acceptSession(): Promise<RdpWasmSession> {
    // Register init-sequence handlers before starting (they match in order).
    this.#on(
      (r) => r.to === "root" && r.type === "listTabs",
      () => ({ from: "root", tabs: [{ actor: "tab1", selected: true }] })
    );
    this.#on(
      (r) => r.to === "tab1" && r.type === "getWatcher",
      () => ({ from: "tab1", actor: "watcher1" })
    );
    this.#on(
      (r) => r.to === "watcher1" && r.type === "getThreadConfigurationActor",
      () => ({ from: "watcher1", configuration: "cfg1" })
    );
    this.#on(
      (r) => r.to === "cfg1" && r.type === "updateConfiguration",
      () => ({ from: "cfg1" })
    );
    this.#on(
      (r) => r.to === "watcher1" && r.type === "watchTargets" && r.targetType === "frame",
      () => ({ from: "watcher1" })
    );
    this.#on(
      (r) => r.to === "watcher1" && r.type === "watchTargets" && r.targetType === "worker",
      () => ({ from: "watcher1" })
    );
    this.#on(
      (r) => r.to === "watcher1" && r.type === "watchResources",
      () => ({ from: "watcher1" })
    );

    // Start the session connection concurrently with waiting for the socket.
    const sessionP = RdpWasmSession.start(this.port);

    // Wait for the connection, then send the root greeting to unblock the client.
    await new Promise<void>((resolve) => {
      if (this.sock) {
        resolve();
        return;
      }
      this.pendingConnect = resolve;
    });
    this.send({ from: "root" }); // triggers RdpClient.#ready

    return sessionP;
  }

  /** Register a handler for requests matching `match`. */
  #on(match: (r: ReqPacket) => boolean, handle: HandlerFn): void {
    this.handlers.push({ match, handle });
  }

  /** Register a one-shot handler for any request (call before that request). */
  onNext(match: (r: ReqPacket) => boolean, handle: HandlerFn): void {
    const entry = { match, handle };
    this.handlers.unshift(entry); // checked before generic handlers
  }

  /** Handle all requests matching `match` (persistent). */
  onAll(match: (r: ReqPacket) => boolean, handle: HandlerFn): void {
    this.handlers.push({ match, handle });
  }

  #dispatch(req: ReqPacket): void {
    const idx = this.handlers.findIndex((h) => h.match(req));
    if (idx === -1) return;
    const { handle } = this.handlers[idx];
    const resp = handle(req);
    if (resp) this.send(resp);
  }

  /** Push an unsolicited event packet into the session. */
  send(packet: object): void {
    this.sock?.write(encode(packet));
  }

  // Helpers to push specific event types ---------------------------------

  targetAvailable(
    threadActor: string,
    opts: {
      consoleActor?: string;
      url?: string;
      isTopLevel?: boolean;
    } = {}
  ): void {
    this.send({
      from: "watcher1",
      type: "target-available-form",
      target: {
        threadActor,
        consoleActor: opts.consoleActor ?? `${threadActor}:console`,
        url: opts.url ?? "http://example.com/",
        isTopLevelTarget: opts.isTopLevel ?? false,
      },
    });
  }

  targetDestroyed(threadActor: string): void {
    this.send({
      from: "watcher1",
      type: "target-destroyed-form",
      target: { threadActor },
    });
  }

  paused(threadActor: string, why = "breakpoint"): void {
    this.send({ from: threadActor, type: "paused", why: { type: why } });
  }

  resumed(threadActor: string): void {
    this.send({ from: threadActor, type: "resumed" });
  }

  close(): void {
    this.sock?.destroy();
    this.srv.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests: thread tracking
// ---------------------------------------------------------------------------

test("target-available-form adds thread to listTids", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  assert.deepEqual(session.listTids(), []);

  srv.targetAvailable("threadA", { isTopLevel: true });
  await sleep(20);
  assert.deepEqual(session.listTids(), [1]);

  srv.targetAvailable("threadB");
  await sleep(20);
  assert.deepEqual(session.listTids(), [1, 2]);

  session.close();
  srv.close();
});

test("target-available-form with same actor is deduplicated", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(20);
  srv.targetAvailable("threadA"); // same actor — should be ignored
  await sleep(20);

  assert.equal(session.listTids().length, 1);
  session.close();
  srv.close();
});

test("target-destroyed-form removes thread from listTids", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);
  assert.equal(session.listTids().length, 2);

  srv.targetDestroyed("threadA");
  await sleep(20);
  assert.equal(session.listTids().length, 1);

  session.close();
  srv.close();
});

test("hasThreads() reflects thread count", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  assert.equal(session.hasThreads(), false);

  srv.targetAvailable("threadA");
  await sleep(20);
  assert.equal(session.hasThreads(), true);

  session.close();
  srv.close();
});

// ---------------------------------------------------------------------------
// Tests: all-stop coordination
// ---------------------------------------------------------------------------

test("paused event from known thread emits paused:<tid>", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(20);
  const tids = session.listTids();
  assert.equal(tids.length, 1);
  const tid = tids[0];

  const pausePackets: PauseEvent[] = [];
  session.on(`paused:${tid}`, (p: PauseEvent) => pausePackets.push(p));

  srv.paused("threadA", "breakpoint");
  await sleep(20);

  assert.equal(pausePackets.length, 1);
  assert.equal(pausePackets[0].why?.type, "breakpoint");
  session.close();
  srv.close();
});

test("paused event from unknown actor is silently dropped", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(20);

  const pauses: unknown[] = [];
  session.on("paused:1", (p: unknown) => pauses.push(p));

  srv.paused("unknownActor", "breakpoint");
  await sleep(20);

  assert.equal(pauses.length, 0);
  session.close();
  srv.close();
});

test("armAllStop → pause from one thread → interrupt others → stopped emitted", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Register two threads.
  srv.targetAvailable("threadA", { isTopLevel: true, consoleActor: "consoleA" });
  srv.targetAvailable("threadB", { consoleActor: "consoleB" });
  await sleep(20);
  assert.equal(session.listTids().length, 2);

  // The interrupt request sent to threadB needs a response; also threadB
  // must emit a paused event so #allStop can complete.
  srv.onAll(
    (r) => r.to === "threadB" && r.type === "interrupt",
    (_r) => {
      // Respond to the interrupt request, then inject the paused event.
      setTimeout(() => srv.paused("threadB", "interrupted"), 5);
      return { from: "threadB" };
    }
  );

  // Arm all-stop and inject a pause from threadA.
  const stoppedEvents: StoppedEvent[] = [];
  session.on("stopped", (e: StoppedEvent) => stoppedEvents.push(e));
  session.armAllStop();
  srv.paused("threadA", "breakpoint");

  // Wait for all-stop to complete.
  await sleep(100);

  assert.equal(stoppedEvents.length, 1, "exactly one stopped event");
  const [stopped] = stoppedEvents;

  // The triggering thread is the one that fired the breakpoint.
  const tids = session.listTids();
  const tidA = tids[0]; // threadA was registered first → TID 1
  assert.equal(stopped.tid, tidA, "stoppedTid is the thread that paused");
  assert.equal(stopped.pausePacket.why?.type, "breakpoint");

  // An interrupt request was sent to threadB.
  const interrupts = srv.received.filter((r) => r.type === "interrupt" && r.to === "threadB");
  assert.ok(interrupts.length >= 1, "interrupt sent to threadB");

  session.close();
  srv.close();
});

test("armAllStop fires only once even if multiple paused events arrive", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);

  // Both threads will emit paused, but only the first triggers all-stop.
  srv.onAll(
    (r) => r.type === "interrupt",
    (r) => ({ from: r.to as string })
  );

  const stoppedEvents: StoppedEvent[] = [];
  session.on("stopped", (e: StoppedEvent) => stoppedEvents.push(e));
  session.armAllStop();

  // Both pause almost simultaneously.
  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "breakpoint");
  await sleep(100);

  assert.equal(stoppedEvents.length, 1, "stopped fires exactly once");
  session.close();
  srv.close();
});

test("stoppedTid and stoppedConsoleActor reflect the triggering thread", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA", { isTopLevel: true, consoleActor: "consoleA" });
  await sleep(20);

  srv.onAll(
    (r) => r.type === "interrupt",
    (r) => ({ from: r.to as string })
  );

  session.armAllStop();
  srv.paused("threadA", "breakpoint");
  await sleep(50);

  const tid = session.listTids()[0];
  assert.equal(session.stoppedTid, tid);
  assert.equal(session.stoppedConsoleActor, "consoleA");

  session.close();
  srv.close();
});

test("stoppedConsoleActor returns null when stopped thread has no console", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Worker with empty consoleActor.
  srv.send({
    from: "watcher1",
    type: "target-available-form",
    target: {
      threadActor: "threadW",
      consoleActor: "",
      url: "http://x.com/",
      isTopLevelTarget: false,
    },
  });
  await sleep(20);

  srv.onAll(
    (r) => r.type === "interrupt",
    (r) => ({ from: r.to as string })
  );
  session.armAllStop();
  srv.paused("threadW", "breakpoint");
  await sleep(50);

  assert.equal(session.stoppedConsoleActor, null);
  session.close();
  srv.close();
});

test("armAllStop arms on thread that arrives after armAllStop() is called", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Arm before any threads exist.
  const stoppedEvents: StoppedEvent[] = [];
  session.on("stopped", (e: StoppedEvent) => stoppedEvents.push(e));
  session.armAllStop();

  // Thread arrives after arming.
  srv.targetAvailable("threadA", { isTopLevel: true });
  await sleep(20);

  srv.paused("threadA", "breakpoint");
  await sleep(50);

  assert.equal(stoppedEvents.length, 1, "stopped emitted for late-arriving thread");
  assert.equal(stoppedEvents[0].pausePacket.why?.type, "breakpoint");
  session.close();
  srv.close();
});

test("allStop does not send interrupt to already-paused thread", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA", { isTopLevel: true });
  srv.targetAvailable("threadB");
  await sleep(20);

  // Pause threadB before arming so it is already in #pausedTids.
  srv.paused("threadB", "interrupted");
  await sleep(20);

  srv.onAll(
    (r) => r.type === "interrupt",
    (r) => ({ from: r.to as string })
  );

  const stoppedEvents: StoppedEvent[] = [];
  session.on("stopped", (e: StoppedEvent) => stoppedEvents.push(e));
  session.armAllStop();
  srv.paused("threadA", "breakpoint");
  await sleep(100);

  assert.equal(stoppedEvents.length, 1, "stopped emitted");
  const interrupts = srv.received.filter((r) => r.type === "interrupt" && r.to === "threadB");
  assert.equal(interrupts.length, 0, "threadB did not receive interrupt");
  session.close();
  srv.close();
});

// ---------------------------------------------------------------------------
// Tests: breakpoint buffering
// ---------------------------------------------------------------------------

test("setWasmBreakpoint buffers breakpoint and applies it to new workers", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Respond to all setBreakpoint requests.
  srv.onAll(
    (r) => r.type === "setBreakpoint",
    (r) => ({ from: r.to as string })
  );

  // Set a breakpoint before any workers appear.
  await session.setWasmBreakpoint("http://host/mod.wasm", 1234);

  // Now a new worker appears.
  srv.targetAvailable("workerT", { consoleActor: "consoleW" });
  await sleep(30);

  // The setBreakpoint request should have been sent to workerT.
  const bps = srv.received.filter((r) => r.type === "setBreakpoint" && r.to === "workerT");
  assert.ok(bps.length >= 1, "setBreakpoint sent to new worker");
  const loc = bps[0].location as { sourceUrl: string; line: number; column: number };
  assert.equal(loc.sourceUrl, "http://host/mod.wasm");
  assert.equal(loc.column, 1);

  session.close();
  srv.close();
});

test("setWasmBreakpoint sends to all existing threads at call time", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);

  srv.onAll(
    (r) => r.type === "setBreakpoint",
    (r) => ({ from: r.to as string })
  );

  await session.setWasmBreakpoint("http://host/mod.wasm", 999);

  const bps = srv.received.filter((r) => r.type === "setBreakpoint");
  const actors = new Set(bps.map((r) => r.to));
  assert.ok(actors.has("threadA"), "breakpoint sent to threadA");
  assert.ok(actors.has("threadB"), "breakpoint sent to threadB");

  session.close();
  srv.close();
});

test("removeWasmBreakpoint sends to all threads and removes from buffer", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(20);

  srv.onAll(
    (r) => r.type === "setBreakpoint" || r.type === "removeBreakpoint",
    (r) => ({ from: r.to as string })
  );

  await session.setWasmBreakpoint("http://host/mod.wasm", 42);
  await session.removeWasmBreakpoint("http://host/mod.wasm", 42);

  const removals = srv.received.filter((r) => r.type === "removeBreakpoint" && r.to === "threadA");
  assert.ok(removals.length >= 1, "removeBreakpoint sent to thread");

  // After removal, a new worker should NOT get the breakpoint.
  srv.targetAvailable("workerNew");
  await sleep(30);

  const newBps = srv.received.filter((r) => r.type === "setBreakpoint" && r.to === "workerNew");
  assert.equal(newBps.length, 0, "removed breakpoint not applied to new worker");

  session.close();
  srv.close();
});

// ---------------------------------------------------------------------------
// Tests: resumeAll
// ---------------------------------------------------------------------------

test("resumeAll sends resume to all paused threads", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);

  // Simulate both threads paused (mark via paused events).
  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(20);

  // resumeAll should send resume to both.
  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );
  await session.resumeAll();
  await sleep(20);

  const resumes = srv.received.filter((r) => r.type === "resume");
  const actors = new Set(resumes.map((r) => r.to));
  assert.ok(actors.has("threadA"), "resumed threadA");
  assert.ok(actors.has("threadB"), "resumed threadB");

  session.close();
  srv.close();
});

test("resumeAll does nothing when no threads are paused", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(20);

  const before = srv.received.length;
  await session.resumeAll(); // no paused threads
  const after = srv.received.length;

  assert.equal(after, before, "no additional packets sent");
  session.close();
  srv.close();
});

test("resumed event removes thread from paused set; resumeAll skips it", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(20);

  // threadA resumes on its own (e.g., prior step completed).
  srv.resumed("threadA");
  await sleep(20);

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const before = srv.received.length;
  await session.resumeAll();
  await sleep(20);

  const resumes = srv.received.slice(before).filter((r) => r.type === "resume");
  const actors = new Set(resumes.map((r) => r.to));
  assert.ok(actors.has("threadB"), "threadB was resumed");
  assert.ok(!actors.has("threadA"), "threadA was not resumed again");
  session.close();
  srv.close();
});

test("target-destroyed-form removes thread from paused set; resumeAll skips it", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  srv.targetAvailable("threadB");
  await sleep(20);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(20);

  srv.targetDestroyed("threadA");
  await sleep(20);

  assert.equal(session.listTids().length, 1, "threadA removed from list");

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const before = srv.received.length;
  await session.resumeAll();
  await sleep(20);

  const resumes = srv.received.slice(before).filter((r) => r.type === "resume");
  const actors = new Set(resumes.map((r) => r.to));
  assert.ok(actors.has("threadB"), "threadB resumed");
  assert.ok(!actors.has("threadA"), "destroyed threadA not resumed");
  session.close();
  srv.close();
});

// ---------------------------------------------------------------------------
// Tests: stepOne
// ---------------------------------------------------------------------------

test("stepOne sends resume with resumeLimit:step only to the specified thread", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA", { isTopLevel: true });
  srv.targetAvailable("threadB");
  await sleep(20);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(20);

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const tidA = session.listTids()[0]; // threadA registered first → TID 1
  await session.stepOne(tidA);
  await sleep(20);

  const resumesA = srv.received.filter((r) => r.type === "resume" && r.to === "threadA");
  const resumesB = srv.received.filter((r) => r.type === "resume" && r.to === "threadB");

  assert.ok(resumesA.length >= 1, "threadA got a resume");
  const limit = resumesA[resumesA.length - 1].resumeLimit as { type: string } | undefined;
  assert.equal(limit?.type, "step", "resume carried resumeLimit:step");
  assert.equal(resumesB.length, 0, "threadB did not get resume");
  session.close();
  srv.close();
});
