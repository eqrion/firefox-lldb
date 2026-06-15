// Reusable GDB-server host: spawns the gdbstub component on a worker thread and
// services its synchronous debuggee RPCs from an async `dispatch` function on
// the main thread (over the SharedArrayBuffer channel). The component listens
// for LLDB on `port`; the main event loop stays free for async work (RDP).

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encode, decode, CTRL_STATE, CTRL_LEN, CTRL_WORDS, STATE_RESPONSE, DATA_BYTES,
} from "./wire.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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
  const ready = new Promise((r) => (resolveReady = r));

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
      const out = encode(resp);
      data.set(out, 0);
      Atomics.store(ctrl, CTRL_LEN, out.length);
      Atomics.store(ctrl, CTRL_STATE, STATE_RESPONSE);
      Atomics.notify(ctrl, CTRL_STATE);
    } else if (m && m.info) {
      onInfo?.(m.info);
      // The component prints "Debugger listening on ..." once the TCP listener
      // is bound; that (not the earlier {ready}) is when LLDB can connect.
      if (/listening/i.test(m.info)) resolveReady();
    }
  });
  worker.on("error", (e) => console.error("[gdb worker error]", e));

  return { ready, stop: () => worker.terminate() };
}
