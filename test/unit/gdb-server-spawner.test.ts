/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GdbServerSpawner,
  LaunchRollbackError,
  type LaunchedServer,
} from "../../src/platform/gdb-server-spawner.js";
import { noopLogger } from "../../src/diagnostics/logger.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const concurrent of [false, true]) {
  test(`failed startup rollback remains visible to shutdown (concurrent=${concurrent})`, async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    const failure = new LaunchRollbackError(
      new Error("startup failed"),
      new Error("cleanup failed")
    );
    const records: string[] = [];
    const spawner = new GdbServerSpawner(
      async () => {
        entered.resolve();
        await finish.promise;
        throw failure;
      },
      { ...noopLogger, debug: (message) => records.push(message) }
    );
    const rejected = assert.rejects(spawner.launch(), (error) => error === failure);
    await entered.promise;
    const closing = concurrent ? assert.rejects(spawner.killAll(), AggregateError) : undefined;
    finish.resolve();
    await rejected;
    await (closing ?? assert.rejects(spawner.killAll(), AggregateError));
    spawner.logState();
    assert.match(records.at(-1)!, /"serverCount":1/);
    assert.match(records.at(-1)!, /"state":"stop-failed"/);
    assert.deepEqual(spawner.list(), []);
  });
}

test("shutdown joins a pending launch and stops its handle without publishing it", async () => {
  const ready = deferred<LaunchedServer>();
  const started = deferred<void>();
  const stopped = deferred<void>();
  let stops = 0;
  const spawner = new GdbServerSpawner(() => {
    started.resolve();
    return ready.promise;
  });
  const launch = assert.rejects(spawner.launch(), /cancelled by shutdown/);
  await started.promise;
  let finished = false;
  const close = spawner.killAll();
  assert.equal(spawner.killAll(), close);
  void close.then(() => {
    finished = true;
  });
  await assert.rejects(spawner.launch(), /spawner is closed/);
  ready.resolve({
    port: 1234,
    stop: () => {
      stops++;
      return stopped.promise;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(spawner.list(), []);
  stopped.resolve();
  await Promise.all([launch, close]);
  assert.equal(stops, 1);
});

test("shutdown before launcher invocation does not start new work", async () => {
  let calls = 0;
  const spawner = new GdbServerSpawner(async () => {
    calls++;
    return { port: 1, stop() {} };
  });
  const launch = assert.rejects(spawner.launch(), /cancelled before starting/);
  await spawner.killAll();
  await launch;
  assert.equal(calls, 0);
});

test("concurrent individual and global shutdown share one asynchronous stop", async () => {
  const stopped = deferred<void>();
  let stops = 0;
  const spawner = new GdbServerSpawner(async () => ({
    port: 1,
    stop: () => {
      stops++;
      return stopped.promise;
    },
  }));
  const { pid } = await spawner.launch();
  const first = spawner.kill(pid);
  const second = spawner.kill(pid);
  const all = spawner.killAll();
  assert.deepEqual(spawner.list(), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  stopped.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await all;
});

test("a synchronous stop failure does not skip other servers or lose failure evidence", async () => {
  let launches = 0;
  let goodStops = 0;
  const lines: string[] = [];
  const spawner = new GdbServerSpawner(
    async () =>
      ++launches === 1
        ? {
            port: 1,
            stop() {
              throw new Error("stop failed");
            },
          }
        : {
            port: 2,
            stop() {
              goodStops++;
            },
          },
    { ...noopLogger, debug: (line) => lines.push(line) }
  );
  const { pid } = await spawner.launch();
  await spawner.launch();
  await assert.rejects(spawner.kill(pid), /stop failed/);
  await assert.rejects(spawner.killAll(), /failed to stop one or more/);
  assert.equal(goodStops, 1);
  spawner.logState();
  assert.match(lines.at(-1)!, /stop-failed/);
});

test("shutdown timeout retains ownership of a late launch", async () => {
  const started = deferred<void>();
  const ready = deferred<LaunchedServer>();
  let stops = 0;
  const lines: string[] = [];
  const spawner = new GdbServerSpawner(
    () => {
      started.resolve();
      return ready.promise;
    },
    {
      ...noopLogger,
      debug: (line) => lines.push(line),
    }
  );
  const launch = assert.rejects(spawner.launch(), /cancelled by shutdown/);
  await started.promise;
  await assert.rejects(spawner.killAll(5), /timed out.*remain owned/);
  assert.match(lines.at(-1)!, /"awaitingLaunch":true/);
  ready.resolve({
    port: 1,
    stop() {
      stops++;
    },
  });
  await launch;
  assert.equal(stops, 1);
  assert.deepEqual(spawner.list(), []);
});

test("shutdown aborts a pending acquisition and joins its rollback", async () => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const rolledBack = deferred<void>();
  const spawner = new GdbServerSpawner(async ({ signal }) => {
    const cancelled = new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          resolve();
        },
        { once: true }
      )
    );
    started.resolve();
    await cancelled;
    await rolledBack.promise;
    signal.throwIfAborted();
    assert.fail("cancelled acquisition must not return a handle");
  });
  const launch = assert.rejects(spawner.launch(), /cancelled by shutdown/);
  await started.promise;
  let closed = false;
  const close = spawner.killAll().then(() => {
    closed = true;
  });
  await aborted.promise;
  assert.equal(closed, false, "abort notification is not rollback completion");
  rolledBack.resolve();
  await Promise.all([launch, close]);
});

test("established handles use stop without aborting their acquisition signal", async () => {
  let acquisitionSignal: AbortSignal | undefined;
  let stopped = false;
  const spawner = new GdbServerSpawner(async ({ signal }) => {
    acquisitionSignal = signal;
    return {
      port: 1,
      stop() {
        stopped = true;
      },
    };
  });
  await spawner.launch();
  await spawner.killAll();
  assert.equal(stopped, true);
  assert.equal(acquisitionSignal?.aborted, false);
});
