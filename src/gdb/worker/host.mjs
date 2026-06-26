/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reusable GDB-server host: spawns the gdbstub component on a worker thread and
// services its synchronous debuggee RPCs from an async `dispatch` function on
// the main thread (over the SharedArrayBuffer channel). The component listens
// for LLDB on `port`; the main event loop stays free for async work (RDP).

import { Worker } from "node:worker_threads";
import {
  encode,
  decode,
  CTRL_STATE,
  CTRL_LEN,
  CTRL_WORDS,
  STATE_RESPONSE,
  DATA_BYTES,
} from "./wire.mjs";

/**
 * @param {object} opts
 * @param {(req: {type:string,id:number,method:string,args:any[]}) => Promise<any>} opts.dispatch
 * @param {number} opts.port  TCP port the component listens on for LLDB.
 * @param {(msg: string) => void} [opts.onInfo]
 * @param {boolean} [opts.verbose]
 */
export function startGdbServer({ dispatch, port, onInfo, verbose }) {
  const sab = new SharedArrayBuffer(16 + DATA_BYTES);
  const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
  const data = new Uint8Array(sab, 16);

  const worker = new Worker(new URL("./component-worker.mjs", import.meta.url), {
    workerData: { sab, port, verbose: !!verbose },
    execArgv: ["--import", "tsx"],
  });

  let resolveReady;
  let rejectReady;
  let boundPort = port;
  const ready = new Promise((r, j) => { resolveReady = r; rejectReady = j; });

  worker.on("message", async (m) => {
    if (m === 1) {
      const len = Atomics.load(ctrl, CTRL_LEN);
      const req = decode(data.subarray(0, len));
      let resp;
      try {
        resp = { ok: true, value: await dispatch(req) };
      } catch (e) {
        resp = { ok: false, error: String(e?.message || e) };
      }
      let out = encode(resp);
      if (out.length > data.length) {
        // A response that overflows the shared buffer (e.g. an unreasonable
        // memory read produced by a non-wasm-plugin session) would throw on
        // data.set and kill the worker. Reply with an error instead.
        out = encode({ ok: false, error: "out-of-bounds" });
      }
      data.set(out, 0);
      Atomics.store(ctrl, CTRL_LEN, out.length);
      Atomics.store(ctrl, CTRL_STATE, STATE_RESPONSE);
      Atomics.notify(ctrl, CTRL_STATE);
    } else if (m && m.info) {
      onInfo?.(m.info);
      // The component prints "Debugger listening on 127.0.0.1:PORT" once the
      // TCP listener is bound; that (not the earlier {ready}) is when LLDB can
      // connect. Parse the port so callers get the actual bound port when
      // port=0 (OS-assigned).
      if (/listening/i.test(m.info)) {
        const match = m.info.match(/:(\d+)/);
        if (match) boundPort = parseInt(match[1], 10);
        resolveReady();
      }
    }
  });
  worker.on("error", (e) => {
    if (e?.code === "ERR_WORKER_OUT_OF_MEMORY") {
      console.error(
        "[gdb worker] out of memory — the session was likely driven by the generic " +
          "gdb-remote plugin, which misreads the wasm address space. Reattach with " +
          "the wasm plugin: `attach --pid N` (firefox-lldb) or " +
          "`process attach --plugin wasm --pid N`."
      );
    } else {
      console.error("[gdb worker error]", e);
    }
    // If the worker crashed before the 'listening' message arrived, unblock
    // the caller who is awaiting gdbServer.ready.
    rejectReady?.(e);
    rejectReady = null;
  });

  return {
    ready,
    stop: () => worker.terminate(),
    get port() {
      return boundPort;
    },
  };
}
