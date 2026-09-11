/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DapTrace } from "../../src/diagnostics/dap-trace.js";
import { noopLogger } from "../../src/diagnostics/logger.js";

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function capture() {
  const records: Record<string, any>[] = [];
  const trace = new DapTrace({ ...noopLogger, debug: (m) => records.push(JSON.parse(m.slice(6))) });
  return { trace, records };
}

test("DAP tracing correlates interleaved and reverse requests across fragmented UTF-8 frames", () => {
  const { trace, records } = capture();
  const request = frame({
    type: "request",
    seq: 1,
    command: "evaluate",
    arguments: { expression: "secret-π🎯" },
  });
  const original = Buffer.from(request);
  for (const byte of request) trace.feed("client->adapter", Uint8Array.of(byte));
  assert.deepEqual(request, original, "observing must not mutate transport bytes");
  trace.feed("client->adapter", frame({ type: "request", seq: 2, command: "threads" }));
  trace.feed("adapter->client", frame({ type: "request", seq: 1, command: "runInTerminal" }));
  trace.feed(
    "adapter->client",
    Buffer.concat([
      frame({
        type: "response",
        seq: 3,
        request_seq: 2,
        success: true,
        command: "threads",
        body: { secret: "hidden" },
      }),
      frame({ type: "event", seq: 4, event: "stopped", body: { reason: "hidden" } }),
      frame({
        type: "response",
        seq: 5,
        request_seq: 1,
        success: false,
        command: "evaluate",
        message: "hidden",
      }),
    ])
  );
  trace.feed(
    "client->adapter",
    frame({ type: "response", seq: 3, request_seq: 1, command: "runInTerminal", success: true })
  );
  trace.logState();
  assert.equal(records.at(-1)!.pendingCount, 0);
  assert.equal(records.at(-1)!.correlationIncomplete, false);
  const responses = records.filter((r) => r.type === "response");
  assert.deepEqual(
    responses.map((r) => r.matchedRequest),
    [true, true, true]
  );
  assert.ok(responses.every((r) => r.durationMs >= 0));
  assert.ok(records.some((r) => r.name === "stopped"));
  assert.doesNotMatch(JSON.stringify(records), /secret|hidden|expression/);
});

test("oversized DAP bodies are skipped without losing the next frame", () => {
  const { trace, records } = capture();
  trace.feed("client->adapter", Buffer.from("Content-Length: 1000000\r\n\r\n"));
  for (let i = 0; i < 1000; i++) trace.feed("client->adapter", Buffer.alloc(1000, 0x61));
  trace.feed("client->adapter", frame({ type: "request", seq: 2, command: "threads" }));
  trace.logState();
  assert.equal(records[0]!.event, "body-omitted");
  assert.equal(records[0]!.bytes, 1000000);
  assert.equal(records.at(-1)!.correlationIncomplete, true);
  assert.equal(records.at(-1)!.pendingCount, 1);
  assert.equal(records.at(-1)!.streams["client->adapter"].messages, 2);
});

test("malformed headers disable only that diagnostic stream", () => {
  const { trace, records } = capture();
  trace.feed("client->adapter", Buffer.from("Content-Length: no\r\n\r\n"));
  trace.feed("client->adapter", frame({ type: "request", seq: 1, command: "ignored" }));
  trace.feed("adapter->client", frame({ type: "event", seq: 1, event: "terminated" }));
  assert.equal(records[0]!.event, "trace-disabled");
  assert.equal(records[1]!.name, "terminated");
  assert.equal(records.length, 2);
});

test("empty and malformed JSON bodies do not lose subsequent DAP frames", () => {
  const { trace, records } = capture();
  trace.feed(
    "client->adapter",
    Buffer.concat([
      Buffer.from("Content-Length: 0\r\n\r\nContent-Length: 1\r\n\r\n{"),
      frame({ type: "request", seq: 1, command: "threads" }),
    ])
  );
  assert.deepEqual(
    records.map((r) => r.event),
    ["invalid-json", "invalid-json", "message"]
  );
  trace.logState();
  assert.equal(records.at(-1)!.pendingCount, 1);
  assert.equal(records.at(-1)!.correlationIncomplete, true);
});

test("duplicate lengths and oversized headers disable tracing with bounded state", () => {
  for (const header of ["Content-Length: 2\r\nContent-Length: 3\r\n\r\n", "x".repeat(100_000)]) {
    const { trace, records } = capture();
    trace.feed("client->adapter", Buffer.from(header));
    trace.logState();
    assert.equal(records[0]!.event, "trace-disabled");
    assert.ok(records.at(-1)!.streams["client->adapter"].headerBytes <= 8192);
  }
});

test("EOF records partial frames and the pending operation snapshot", () => {
  const { trace, records } = capture();
  trace.feed("client->adapter", frame({ type: "request", seq: 1, command: "attach" }));
  trace.feed("adapter->client", Buffer.from("Content-Length: 99\r\n\r\n{"));
  trace.end("adapter->client");
  trace.end("adapter->client");
  trace.logState("shutdown");
  assert.equal(records.filter((r) => r.event === "truncated-stream").length, 1);
  assert.equal(records.at(-1)!.pending[0].command, "attach");
  assert.equal(records.at(-1)!.streams["adapter->client"].bodyBytes, 1);
});

test("DAP pending requests and snapshot size are bounded", () => {
  const { trace, records } = capture();
  for (let seq = 0; seq < 300; seq++)
    trace.feed("client->adapter", frame({ type: "request", seq, command: "x".repeat(1000) }));
  trace.logState();
  const snapshot = records.at(-1)!;
  assert.equal(snapshot.pendingCount, 256);
  assert.equal(snapshot.pending.length, 20);
  assert.equal(snapshot.omittedPending, 236);
  assert.equal(snapshot.correlationIncomplete, true);
  assert.ok(JSON.stringify(snapshot).length < 5000);
});
