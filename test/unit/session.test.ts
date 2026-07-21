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
import { encodeRdpFrame, sliceRdpFrame } from "../../src/rdp/transport.js";

// ---------------------------------------------------------------------------
// Fake RDP server
// ---------------------------------------------------------------------------

function decodeAll(buf: Buffer): { packets: Record<string, unknown>[]; rest: Buffer } {
  const packets: Record<string, unknown>[] = [];
  for (;;) {
    const sliced = sliceRdpFrame(buf);
    if (!sliced) break;
    packets.push(JSON.parse(sliced.body));
    buf = sliced.rest;
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
  private handlers: Array<{ match: (r: ReqPacket) => boolean; handle: HandlerFn; once?: boolean }> =
    [];
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
    const entry = { match, handle, once: true };
    this.handlers.unshift(entry); // checked before generic handlers
  }

  /** Handle all requests matching `match` (persistent). */
  onAll(match: (r: ReqPacket) => boolean, handle: HandlerFn): void {
    this.handlers.push({ match, handle });
  }

  #dispatch(req: ReqPacket): void {
    const idx = this.handlers.findIndex((h) => h.match(req));
    if (idx === -1) return;
    const { handle, once } = this.handlers[idx];
    if (once) this.handlers.splice(idx, 1);
    const resp = handle(req);
    if (resp) this.send(resp);
  }

  /** Push an unsolicited event packet into the session. */
  send(packet: object): void {
    this.sock?.write(encodeRdpFrame(packet));
  }

  /** Push multiple packets in one socket write to exercise same-chunk races. */
  sendTogether(...packets: object[]): void {
    this.sock?.write(Buffer.concat(packets.map(encodeRdpFrame)));
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
        // The window/frame target actor, distinct from the thread actor —
        // target-destroyed-form only carries this one (see targetDestroyed).
        actor: `${threadActor}:target`,
        threadActor,
        consoleActor: opts.consoleActor ?? `${threadActor}:console`,
        url: opts.url ?? "http://example.com/",
        isTopLevelTarget: opts.isTopLevel ?? false,
      },
    });
  }

  /** Real Firefox's target-destroyed-form carries the window/frame target
   * actor, not the thread actor — mirror that here rather than threadActor. */
  targetDestroyed(threadActor: string): void {
    this.send({
      from: "watcher1",
      type: "target-destroyed-form",
      target: { actor: `${threadActor}:target` },
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

test("RdpWasmSession.start closes its socket when initialization fails", async () => {
  let socketClosed!: () => void;
  const closed = new Promise<void>((resolve) => (socketClosed = resolve));
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("close", socketClosed);
    socket.write(encodeRdpFrame({ from: "root" }));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeAll(buf);
      buf = decoded.rest as Buffer<ArrayBuffer>;
      for (const packet of decoded.packets) {
        if (packet.to === "root" && packet.type === "listTabs") {
          socket.write(encodeRdpFrame({ from: "root", tabs: [] }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  await assert.rejects(RdpWasmSession.start(port), /no Firefox tab found/);
  await closed;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests: thread tracking
// ---------------------------------------------------------------------------

test("target-available-form adds thread to listTids", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  assert.deepEqual(session.listTids(), []);

  srv.targetAvailable("threadA", { isTopLevel: true });
  await sleep(200);
  assert.deepEqual(session.listTids(), [1]);

  srv.targetAvailable("threadB");
  await sleep(200);
  assert.deepEqual(session.listTids(), [1, 2]);

  session.close();
  srv.close();
});

test("target-available-form with same actor is deduplicated", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(200);
  srv.targetAvailable("threadA"); // same actor — should be ignored
  await sleep(200);

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
  await sleep(200);
  assert.equal(session.listTids().length, 2);

  srv.targetDestroyed("threadA");
  await sleep(200);
  assert.equal(session.listTids().length, 1);

  session.close();
  srv.close();
});

test("target-destroyed-form with real Firefox payload shape (no threadActor) prunes the right thread", async () => {
  // Real Firefox target-destroyed-form carries only the window/frame target
  // actor plus innerWindowId/isTopLevelTarget — never threadActor. This
  // happens on every Fission process swap (e.g. the extra reload right after
  // the first cross-origin navigation from about:blank). Matching on
  // threadActor here would silently no-op, leaving a dead thread in
  // #threads that a later all-stop interrupt hangs on forever.
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA", { isTopLevel: true });
  await sleep(200);
  const tidA = session.listTids()[0];

  srv.send({
    from: "watcher1",
    type: "target-destroyed-form",
    target: { actor: "threadA:target", innerWindowId: 1, isTopLevelTarget: true },
  });
  await sleep(200);

  assert.deepEqual(session.listTids(), [], "the destroyed thread must be pruned");

  srv.targetAvailable("threadB", { isTopLevel: true });
  await sleep(200);
  const tidB = session.listTids()[0];
  // Reused, not fresh: LLDB has no RSP mechanism to learn "tid N is gone,
  // thread state referencing it is stale" (gdbstub has no thread-exited/exec
  // stop reason), and its own breakpoint step-off dance keeps addressing the
  // old tid regardless of what we tell it. Keeping the number stable across
  // the swap means that stale-looking reference is actually still valid,
  // now pointed at the new page's thread (see #pendingTopLevelTid).
  assert.equal(tidB, tidA, "the swapped-in top-level thread reuses the old tid");

  session.close();
  srv.close();
});

test("hasThreads() reflects thread count", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  assert.equal(session.hasThreads(), false);

  srv.targetAvailable("threadA");
  await sleep(200);
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
  await sleep(200);
  const tids = session.listTids();
  assert.equal(tids.length, 1);
  const tid = tids[0];

  const pausePackets: PauseEvent[] = [];
  session.on(`paused:${tid}`, (p: PauseEvent) => pausePackets.push(p));

  srv.paused("threadA", "breakpoint");
  await sleep(200);

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
  await sleep(200);

  const pauses: unknown[] = [];
  session.on("paused:1", (p: unknown) => pauses.push(p));

  srv.paused("unknownActor", "breakpoint");
  await sleep(200);

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
  await sleep(200);
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
  await sleep(200);

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
  await sleep(200);

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
  await sleep(200);

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
  await sleep(200);

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
  await sleep(200);

  // Pause threadB before arming so it is already in #pausedTids.
  srv.paused("threadB", "interrupted");
  await sleep(200);

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
  // #applyBreakpoints polls the new target's sources before snapping (see
  // its own test below); answer with none so the poll exhausts quickly
  // instead of hitting its per-attempt timeout on every retry.
  srv.onAll(
    (r) => r.type === "sources",
    (r) => ({ from: r.to as string, sources: [] })
  );

  // Set a breakpoint before any workers appear.
  await session.setWasmBreakpoint("http://host/mod.wasm", 1234);

  // Now a new worker appears.
  srv.targetAvailable("workerT", { consoleActor: "consoleW" });
  await sleep(700);

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
  await sleep(200);

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

test("removeWasmBreakpoint uses same offset wire as setWasmBreakpoint", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA", { isTopLevel: true });
  await sleep(200);

  srv.onAll(
    (r) => r.type === "setBreakpoint" || r.type === "removeBreakpoint",
    (r) => ({ from: r.to as string })
  );

  // No wasmActorByUrl entry → #snapOffset returns offset unchanged.
  // Verify set and remove both send the same offset (42) so a real snapped
  // remove would also use the snapped value rather than the original.
  await session.setWasmBreakpoint("http://host/mod.wasm", 42);
  await session.removeWasmBreakpoint("http://host/mod.wasm", 42);

  const setLine = (
    srv.received.find((r) => r.type === "setBreakpoint")?.location as { line?: number }
  )?.line;
  const removeLine = (
    srv.received.find((r) => r.type === "removeBreakpoint")?.location as { line?: number }
  )?.line;

  assert.equal(setLine, 42);
  assert.equal(removeLine, 42, "removeBreakpoint must send same offset as setBreakpoint");

  session.close();
  srv.close();
});

test("removeWasmBreakpoint sends to all threads and removes from buffer", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("threadA");
  await sleep(200);

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
  await sleep(200);

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
  await sleep(200);

  // Simulate both threads paused (mark via paused events).
  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(200);

  // resumeAll should send resume to both.
  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );
  await session.resumeAll();
  await sleep(200);

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
  await sleep(200);

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
  await sleep(200);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(200);

  // threadA resumes on its own (e.g., prior step completed).
  srv.resumed("threadA");
  await sleep(200);

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const before = srv.received.length;
  await session.resumeAll();
  await sleep(200);

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
  await sleep(200);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(200);

  srv.targetDestroyed("threadA");
  await sleep(200);

  assert.equal(session.listTids().length, 1, "threadA removed from list");

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const before = srv.received.length;
  await session.resumeAll();
  await sleep(200);

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
  await sleep(200);

  srv.paused("threadA", "breakpoint");
  srv.paused("threadB", "interrupted");
  await sleep(200);

  srv.onAll(
    (r) => r.type === "resume",
    (r) => ({ from: r.to as string })
  );

  const tidA = session.listTids()[0]; // threadA registered first → TID 1
  await session.stepOne(tidA);
  await sleep(200);

  const resumesA = srv.received.filter((r) => r.type === "resume" && r.to === "threadA");
  const resumesB = srv.received.filter((r) => r.type === "resume" && r.to === "threadB");

  assert.ok(resumesA.length >= 1, "threadA got a resume");
  const limit = resumesA[resumesA.length - 1].resumeLimit as { type: string } | undefined;
  assert.equal(limit?.type, "step", "resume carried resumeLimit:step");
  assert.equal(resumesB.length, 0, "threadB did not get resume");
  session.close();
  srv.close();
});

// ---------------------------------------------------------------------------
// Tests: tab close / detached event
// ---------------------------------------------------------------------------

test("target-destroyed-form for top-level target emits 'detached'", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("mainThread", { isTopLevel: true });
  srv.targetAvailable("workerThread");
  await sleep(200);
  assert.equal(session.listTids().length, 2);

  let detachCount = 0;
  session.on("detached", () => detachCount++);

  // Destroying a worker should NOT emit "detached".
  srv.targetDestroyed("workerThread");
  await sleep(200);
  assert.equal(detachCount, 0, "worker destruction should not emit detached");
  assert.equal(session.listTids().length, 1, "worker removed from list");

  // Destroying the top-level target (page closed) SHOULD emit "detached",
  // after the grace period for a possible process-swap replacement elapses.
  srv.targetDestroyed("mainThread");
  await sleep(400);
  assert.equal(detachCount, 1, "page close should emit detached exactly once");
  assert.equal(session.listTids().length, 0, "main thread removed from list");

  session.close();
  srv.close();
});

test("target-destroyed-form followed by a replacement top-level target does not emit 'detached'", async () => {
  // Fission can destroy-and-recreate the top-level target as an internal
  // process swap (e.g. the process reassignment that often follows the very
  // first cross-origin navigation from about:blank), with the replacement's
  // target-available-form arriving shortly after the destroy rather than
  // before it. This must not be mistaken for the tab closing.
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("mainThread", { isTopLevel: true, url: "http://example.com/" });
  await sleep(200);

  let detachCount = 0;
  session.on("detached", () => detachCount++);

  srv.targetDestroyed("mainThread");
  await sleep(50);
  srv.targetAvailable("mainThreadSwapped", { isTopLevel: true, url: "http://example.com/" });
  await sleep(400);

  assert.equal(detachCount, 0, "process-swap replacement must NOT emit detached");
  assert.equal(session.listTids().length, 1, "swapped-in target present after swap");
  assert.equal(session.topLevelUrl(), "http://example.com/");

  session.close();
  srv.close();
});

test("session emits 'close' when the RDP connection drops", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  let closeFired = false;
  session.on("close", () => {
    closeFired = true;
  });

  srv.close();
  await sleep(200);

  assert.equal(closeFired, true, "session should emit 'close' on transport close");
  session.close();
});

test("navigate() rejects when the session closes before the new target arrives", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Start with a top-level target.
  srv.targetAvailable("threadV0", { isTopLevel: true, url: "http://example.com/" });
  await sleep(200);

  // Register a navigateTo handler that responds but never sends a new target.
  srv.onNext(
    (r) => r.type === "navigateTo",
    () => ({ from: "tab1" })
  );

  // Start navigate() then immediately close the session before the new target arrives.
  const navP = session.navigate("http://example.com/new.html");
  await sleep(50);
  srv.close();

  await assert.rejects(navP, /session closed during navigate/, "navigate should reject on close");

  session.close();
});

test("navigate() resolves when the resulting page URL differs from the requested one (redirect)", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  // Real servers commonly redirect (bare domain -> www, http -> https,
  // trailing slash, etc.), so the top-level target that actually arrives can
  // have a different URL than the one requested. navigate() must still
  // resolve instead of waiting forever for an exact URL match.
  srv.onNext(
    (r) => r.type === "navigateTo",
    () => {
      srv.targetAvailable("threadRedirected", {
        isTopLevel: true,
        url: "https://www.example.com/",
      });
      return { from: "tab1" };
    }
  );

  await session.navigate("https://example.com/");

  assert.equal(session.listTids().length, 1);
  assert.equal(session.topLevelUrl(), "https://www.example.com/");

  session.close();
  srv.close();
});

test("navigate() same-URL reload does not emit 'detached' for the old target", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  const PAGE_URL = "http://example.com/page.html";

  // Start with a top-level target at PAGE_URL (simulating the page already loaded).
  srv.targetAvailable("threadV1", { isTopLevel: true, url: PAGE_URL });
  await sleep(200);
  assert.equal(session.listTids().length, 1);

  let detachCount = 0;
  session.on("detached", () => detachCount++);

  // When navigate() is called, it sends navigateTo to "tab1". The handler
  // simulates Firefox destroying the old target and creating a new one with
  // the same URL (a reload).
  srv.onNext(
    (r) => r.type === "navigateTo",
    () => {
      srv.targetDestroyed("threadV1");
      srv.targetAvailable("threadV2", { isTopLevel: true, url: PAGE_URL });
      return { from: "tab1" };
    }
  );

  // navigate() should resolve (new target arrived) without emitting "detached".
  await session.navigate(PAGE_URL);

  assert.equal(detachCount, 0, "same-URL reload must NOT emit detached");
  assert.equal(session.listTids().length, 1, "new target present after reload");

  session.close();
  srv.close();
});

test("frames() rejects immediately when session closes while waiting", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("thread1", { isTopLevel: true });
  await sleep(200);
  const tids = session.listTids();
  assert.equal(tids.length, 1);

  // Register a handler for frames that never responds, simulating a thread
  // in mid-resume transition.
  srv.onNext(
    (r) => r.type === "frames",
    () => null
  );

  const framesP = session.frames(tids[0]);

  // Close the session before the frames response arrives.
  await sleep(50);
  srv.close();

  await assert.rejects(framesP, /session closed/, "frames() should reject immediately on close");

  session.close();
});

test("navigate() clears stale source-actor caches so post-navigation breakpoints snap correctly", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("thread1", { isTopLevel: true, url: "http://example.com/v1.html" });
  await sleep(200);

  // Simulate jsSources() populating #jsActorByUrl with an actor for the old page.
  srv.onNext(
    (r) => r.type === "sources",
    () => ({
      from: "thread1",
      sources: [
        {
          actor: "oldJsActor",
          url: "http://example.com/app.js",
          introductionType: "scriptElement",
        },
      ],
    })
  );
  await session.jsSources();

  // Navigate to a new page — should clear the stale actor cache.
  srv.onNext(
    (r) => r.type === "navigateTo",
    () => {
      srv.targetDestroyed("thread1");
      srv.targetAvailable("thread2", { isTopLevel: true, url: "http://example.com/v2.html" });
      return { from: "tab1" };
    }
  );
  await session.navigate("http://example.com/v2.html");

  // After navigation, jsSources() returns a different actor for the same URL.
  srv.onNext(
    (r) => r.type === "sources",
    () => ({
      from: "thread2",
      sources: [
        {
          actor: "newJsActor",
          url: "http://example.com/app.js",
          introductionType: "scriptElement",
        },
      ],
    })
  );
  const sources = await session.jsSources();

  // The old actor should be gone; the new actor should be registered.
  assert.ok(
    sources.some((s) => s.actor === "newJsActor"),
    "new actor should be registered after navigation"
  );

  session.close();
  srv.close();
});

test("uncontrolled top-level target swap (no navigate()) invalidates stale wasm actor caches", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  const WASM_URL = "http://example.com/mod.wasm";

  srv.targetAvailable("thread1", { isTopLevel: true, url: "http://example.com/v1.html" });
  await sleep(200);

  // Simulate #allModules() refreshing wasm sources on a stop, the same way
  // it does on every real debuggee pause — thread1's module reports
  // breakpoint positions [10, 20, 30].
  srv.onNext(
    (r) => r.type === "sources",
    () => ({
      from: "thread1",
      sources: [{ actor: "wasmActorOld", url: WASM_URL, introductionType: "wasm" }],
    })
  );
  await session.wasmSources();

  srv.onNext(
    (r) => r.type === "getBreakpointPositionsCompressed",
    () => ({ from: "wasmActorOld", positions: { 10: [], 20: [], 30: [] } })
  );
  let firstSetLine: number | undefined;
  srv.onNext(
    (r) => r.type === "setBreakpoint",
    (r) => {
      firstSetLine = (r.location as { line: number }).line;
      return { from: "thread1" };
    }
  );

  await session.setWasmBreakpoint(WASM_URL, 12);
  assert.equal(
    firstSetLine,
    10,
    "sanity check: initial breakpoint snaps against thread1's own positions"
  );

  // Simulate an uncontrolled destroy+recreate of the top-level target — no
  // session.navigate() call, e.g. a page self-redirect or a Fission swap.
  // wasmActorOld is now dead; nothing must reuse it.
  srv.targetDestroyed("thread1");
  await sleep(50);

  let secondSetLine: number | undefined;
  srv.onNext(
    (r) => r.type === "setBreakpoint",
    (r) => {
      secondSetLine = (r.location as { line: number }).line;
      return { from: "thread2" };
    }
  );
  // #applyBreakpoints polls thread2's sources before snapping; answer with
  // none (nothing has refreshed sources for the new target yet, same as in
  // production before the next debuggee stop) so the poll exhausts quickly
  // instead of hitting its per-attempt timeout on every retry.
  srv.onAll(
    (r) => r.type === "sources",
    (r) => ({ from: r.to as string, sources: [] })
  );
  srv.targetAvailable("thread2", { isTopLevel: true, url: "http://example.com/v1.html" });
  await sleep(700);

  // thread2's source actors never resolved (the poll above exhausted) — the
  // re-applied breakpoint must fall back to the unsnapped offset rather
  // than hang or crash trying to reach the now-dead wasmActorOld.
  assert.equal(
    secondSetLine,
    12,
    "breakpoint re-applied right away (before the next stop's sources refresh) must degrade to unsnapped, not touch the dead actor"
  );

  // Once something does refresh sources for the new target (e.g. the next
  // stop's #allModules()), the stale actor must be gone and the new one used.
  srv.onNext(
    (r) => r.type === "sources",
    () => ({
      from: "thread2",
      sources: [{ actor: "wasmActorNew", url: WASM_URL, introductionType: "wasm" }],
    })
  );
  const sources = await session.wasmSources();
  assert.ok(
    sources.some((s) => s.actor === "wasmActorNew"),
    "new actor should be registered after the uncontrolled swap"
  );

  session.close();
  srv.close();
});

test("fetchModuleBytes reads browser-owned ArrayBuffer source actors", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();
  const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

  srv.targetAvailable("thread1", { isTopLevel: true });
  await sleep(200);
  srv.onNext(
    (r) => r.type === "sources",
    () => ({
      from: "thread1",
      sources: [{ actor: "wasmSource", url: "wasm:fixture", introductionType: "wasm" }],
    })
  );
  await session.wasmSources();
  srv.onNext(
    (r) => r.to === "wasmSource" && r.type === "source",
    () => ({
      from: "wasmSource",
      source: { actor: "arrayBuffer1", length: wasm.length, typeName: "arraybuffer" },
    })
  );
  srv.onNext(
    (r) => r.to === "arrayBuffer1" && r.type === "slice",
    () => ({ from: "arrayBuffer1", encoded: Buffer.from(wasm).toString("base64") })
  );
  srv.onNext(
    (r) => r.to === "arrayBuffer1" && r.type === "release",
    () => ({ from: "arrayBuffer1" })
  );

  assert.deepEqual(await session.fetchModuleBytes("wasm:fixture"), wasm);

  session.close();
  srv.close();
});

test("evalJS captures an evaluationResult delivered with its acknowledgement", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("thread1", { isTopLevel: true, consoleActor: "console1" });
  await sleep(200);

  srv.onNext(
    (r) => r.type === "evaluateJSAsync",
    () => {
      srv.sendTogether(
        { from: "console1", resultID: "same-chunk-result" },
        {
          from: "console1",
          type: "evaluationResult",
          resultID: "same-chunk-result",
          result: 42,
        }
      );
      return null;
    }
  );

  const result = await session.evalJS("6 * 7");
  assert.equal(result.result, 42);

  session.close();
  srv.close();
});

test("evalJS rejects immediately when session closes while waiting for evaluationResult", async () => {
  const srv = new FakeRdpServer();
  await srv.listen();
  const session = await srv.acceptSession();

  srv.targetAvailable("thread1", { isTopLevel: true, consoleActor: "console1" });
  await sleep(200);

  // Register a handler that returns a resultID but never sends the evaluationResult event.
  srv.onNext(
    (r) => r.type === "evaluateJSAsync",
    () => ({ from: "console1", resultID: "test-result-1" })
  );

  const evalP = session.evalJS("1 + 1");

  // Close the session before the evaluationResult event arrives.
  await sleep(50);
  srv.close();

  await assert.rejects(evalP, /session closed/, "evalJS should reject immediately on close");

  session.close();
});
