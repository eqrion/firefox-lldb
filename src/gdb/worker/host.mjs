/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reusable GDB-server host: spawns the gdbstub component on a worker thread and
// services its synchronous debuggee RPCs from an async `dispatch` function on
// the main thread (over the SharedArrayBuffer channel). The component listens
// for LLDB on `port`; the main event loop stays free for async work (RDP).

import { Worker } from "node:worker_threads";
import { parseRequest, wireError, isRecord } from "./contract.mjs";
import {
  encode,
  decode,
  CTRL_STATE,
  CTRL_LEN,
  CTRL_WORDS,
  STATE_RESPONSE,
  STATE_REQUEST,
  DATA_BYTES,
} from "./wire.mjs";

/**
 * @param {object} opts
 * @param {(req: import("./contract.mjs").RpcRequest) => unknown | Promise<unknown>} opts.dispatch
 * @param {number} opts.port  TCP port the component listens on for LLDB.
 * @param {(msg: string) => void} [opts.onInfo]
 * @param {(msg: string) => void} [opts.onTrace]
 * @param {(msg: string) => void} [opts.onError]  Defaults to console.error.
 * @param {(error: Error) => void} [opts.onFailure] Called when the worker crashes.
 * @param {boolean} [opts.verbose]
 * @param {number} [opts.startupTimeoutMs] Bounds initialization, not program execution.
 */
export function startGdbServer({
  dispatch,
  port,
  onInfo,
  onTrace,
  onError,
  onFailure,
  verbose,
  startupTimeoutMs = 30_000,
}) {
  const reportError = onError ?? ((msg) => console.error(msg));
  const sab = new SharedArrayBuffer(16 + DATA_BYTES);
  const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
  const data = new Uint8Array(sab, 16);

  const worker = new Worker(new URL("./component-worker.mjs", import.meta.url), {
    workerData: { sab, port, verbose: !!verbose },
  });

  /** @type {(() => void) | undefined} */
  let resolveReady;
  /** @type {((error: Error) => void) | undefined} */
  let rejectReady;
  let boundPort = port;
  const ready = new Promise(
    /** @param {(value?: void) => void} r */ (r, j) => {
      resolveReady = r;
      rejectReady = j;
    }
  );
  /** @type {Promise<void> | undefined} */
  let stopPromise;
  let done = false;
  /** @type {Error | undefined} */
  let failure;
  /** @type {import("./contract.mjs").RpcRequest | undefined} */
  let currentRpc;
  const stop = () => {
    clearTimeout(startupTimer);
    return (stopPromise ??= worker.terminate().then(() => {}));
  };
  /** @param {Error} error */
  const fail = (error) => {
    if (failure || stopPromise) return;
    failure = error;
    clearTimeout(startupTimer);
    rejectReady?.(error);
    rejectReady = undefined;
    // Start termination before notifying owners: their cleanup may reenter stop.
    void stop().catch((error) => reportError(`[gdb worker] termination failed: ${error}`));
    reportError(
      `[gdb worker] ${error.stack || error}; activeRpc=${JSON.stringify(currentRpc ? { sequence: currentRpc.sequence, type: currentRpc.type, method: currentRpc.method } : null)}`
    );
    onFailure?.(error);
  };
  const startupTimer = setTimeout(
    () => fail(new Error(`gdb worker startup timed out after ${startupTimeoutMs} ms`)),
    startupTimeoutMs
  );

  worker.on(
    "message",
    /** @param {unknown} m */ async (m) => {
      if (stopPromise) return;
      if (m === 1) {
        let out;
        /** @type {import("./contract.mjs").RpcRequest | undefined} */
        let req;
        let ok = false;
        if (currentRpc) {
          fail(new Error("overlapping gdb worker RPC"));
          return;
        }
        const started = performance.now();
        try {
          if (Atomics.load(ctrl, CTRL_STATE) !== STATE_REQUEST)
            throw new Error("gdb RPC notification without pending request");
          const len = Atomics.load(ctrl, CTRL_LEN);
          if (len < 0 || len > data.length) throw new Error("invalid worker request length");
          req = parseRequest(decode(data.subarray(0, len)));
          currentRpc = req;
          onTrace?.(
            `[rpc] request ${req.sequence ?? "?"} ${req.type}.${req.method} resource=${req.id}`
          );
          out = encode({ ok: true, sequence: req.sequence, value: await dispatch(req) });
          ok = true;
        } catch (e) {
          if (stopPromise) {
            currentRpc = undefined;
            return;
          }
          const error = wireError(e);
          if (error.kind === "fatal") {
            const where = req ? `${req.type}.${req.method}` : "<undecodable request>";
            reportError(
              `[gdb dispatch error] ${where}: ${e instanceof Error ? e.stack : String(e)}`
            );
          }
          if (!req) {
            fail(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          out = encode({ ok: false, sequence: req.sequence, error });
        }
        currentRpc = undefined;
        if (stopPromise) return;
        data.set(out, 0);
        Atomics.store(ctrl, CTRL_LEN, out.length);
        Atomics.store(ctrl, CTRL_STATE, STATE_RESPONSE);
        Atomics.notify(ctrl, CTRL_STATE);
        if (req) {
          onTrace?.(
            `[rpc] response ${req.sequence ?? "?"} ${req.type}.${req.method} ` +
              `ok=${ok} durationMs=${Math.round(performance.now() - started)}`
          );
        }
      } else if (isRecord(m) && typeof m.info === "string") {
        onInfo?.(m.info);
      } else if (isRecord(m) && "listening" in m) {
        if (!resolveReady) {
          fail(new Error("duplicate gdb worker readiness"));
          return;
        }
        if (
          typeof m.listening !== "number" ||
          !Number.isInteger(m.listening) ||
          m.listening < 1 ||
          m.listening > 65535
        ) {
          fail(new Error(`invalid gdb worker listening port: ${m.listening}`));
          return;
        }
        boundPort = m.listening;
        onTrace?.(`[worker] listening port=${boundPort}`);
        clearTimeout(startupTimer);
        resolveReady?.();
        resolveReady = undefined;
        rejectReady = undefined;
      } else if (isRecord(m) && m.done === true) {
        done = true;
      } else if (isRecord(m) && typeof m.trace === "string") {
        onTrace?.(m.trace);
      } else {
        fail(new Error("invalid gdb worker control message"));
      }
    }
  );
  worker.on("error", (e) => {
    if ("code" in e && e.code === "ERR_WORKER_OUT_OF_MEMORY") {
      reportError(
        "[gdb worker] out of memory — the session was likely driven by the generic " +
          "gdb-remote plugin, which misreads the wasm address space. Reattach with " +
          "the wasm plugin: `attach --pid N` (firefox-lldb) or " +
          "`process attach --plugin wasm --pid N`."
      );
    }
    // If the worker crashed before the 'listening' message arrived, unblock
    // the caller who is awaiting gdbServer.ready.
    fail(e);
  });
  // Also reject ready on clean exit (e.g. stop() called before 'listening').
  worker.on("exit", (code) => {
    clearTimeout(startupTimer);
    if (!stopPromise && (!done || code !== 0))
      fail(new Error(`gdb worker exited unexpectedly (code ${code})`));
    rejectReady?.(new Error("gdb worker exited before becoming ready"));
    rejectReady = undefined;
  });

  return {
    ready,
    stop,
    get port() {
      return boundPort;
    },
  };
}
