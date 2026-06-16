// Main thread: spawn the component worker, service its synchronous debuggee
// RPCs from an async (fake) debuggee, keep a heartbeat running, and drive the
// GDB connection in-process. Proves option C: the component (on the worker)
// blocks for each debuggee call while the main loop stays free for async work.

import { Worker } from "node:worker_threads";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encode,
  decode,
  CTRL_STATE,
  CTRL_LEN,
  CTRL_WORDS,
  STATE_RESPONSE,
  DATA_BYTES,
} from "./wire.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8771;
const RESUME_MS = 150;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const sab = new SharedArrayBuffer(16 + DATA_BYTES);
const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
const data = new Uint8Array(sab, 16);

// --- Fake async debuggee (stands in for the RDP client) -------------------
const wasmBytes = new Uint8Array(
  await readFile(path.join(here, "../../../../examples/simple/math.wasm"))
);
const i32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
};
const MODULE = { $res: "Module", id: 1 };
const INSTANCE = { $res: "Instance", id: 2 };
const FRAME = { $res: "Frame", id: 3 };
const EVENT_FUTURE = { $res: "EventFuture", id: 4 };

// WasmValue is a real resource: the value's data lives here, keyed by id, and
// the worker proxies its reads back over RPC (jco does not preserve JS instance
// data across a resource-handle round-trip, so inline data is not an option).
let nextValId = 100;
const values = new Map();
const wasmVal = (wtype, bytes) => {
  const id = nextValId++;
  values.set(id, { wtype, bytes });
  return { $res: "WasmValue", id };
};

let resumes = 0;
async function dispatch(req) {
  const key = `${req.type}.${req.method}`;
  await delay(5); // simulate RDP latency on every call
  switch (key) {
    case "Debuggee.allModules":
      return [MODULE];
    case "Debuggee.allInstances":
      return [];
    case "Debuggee.exitFrames":
      return [FRAME];
    case "Debuggee.continue":
    case "Debuggee.singleStep":
      return EVENT_FUTURE;
    case "Debuggee.interrupt":
      return null;
    case "Module.uniqueId":
      return 1n;
    case "Module.bytecode":
      return wasmBytes;
    case "Module.addBreakpoint":
    case "Module.removeBreakpoint":
      return null;
    case "Instance.getModule":
      return MODULE;
    case "Instance.uniqueId":
      return 1n;
    case "Frame.getInstance":
      return INSTANCE;
    case "Frame.getFuncIndex":
      return 0;
    case "Frame.getPc":
      return 0x10;
    case "Frame.getLocals":
      return [wasmVal({ tag: "wasm-i32" }, i32(0xdeadbeef))];
    case "Frame.getStack":
      return [];
    case "Frame.parentFrame":
      return null;
    case "WasmValue.getType":
      return values.get(req.id).wtype;
    case "WasmValue.unwrapI32":
      return new DataView(values.get(req.id).bytes.buffer).getUint32(0, true);
    case "WasmValue.clone": {
      const v = values.get(req.id);
      return wasmVal(v.wtype, v.bytes);
    }
    case "EventFuture.finish":
      // Block (asynchronously) until the next "paused" event, then report it.
      console.log(`[host] finish() awaiting paused event (resume #${++resumes})...`);
      await delay(RESUME_MS);
      console.log("[host] paused -> breakpoint");
      return { tag: "breakpoint" };
    default:
      throw new Error(`unhandled ${key}`);
  }
}

// --- Worker + sync-RPC server ---------------------------------------------
const worker = new Worker(new URL("./component-worker.mjs", import.meta.url), {
  workerData: { sab, port: PORT },
  execArgv: ["--import", "tsx"],
});

let serving = false;
worker.on("message", async (m) => {
  if (m === 1) {
    if (serving) return;
    serving = true;
    const len = Atomics.load(ctrl, CTRL_LEN);
    const req = decode(data.subarray(0, len));
    let resp;
    try {
      resp = { ok: true, value: await dispatch(req) };
    } catch (e) {
      resp = { ok: false, error: String(e.message || e) };
    }
    const out = encode(resp);
    data.set(out, 0);
    Atomics.store(ctrl, CTRL_LEN, out.length);
    Atomics.store(ctrl, CTRL_STATE, STATE_RESPONSE);
    Atomics.notify(ctrl, CTRL_STATE);
    serving = false;
  } else if (m && m.info) {
    console.log("[component]", m.info);
  } else if (m && m.ready) {
    driveClient();
  }
});
worker.on("error", (e) => console.error("[worker error]", e));

let beats = 0;
const hb = setInterval(() => console.log(`[heartbeat ${++beats}] main loop alive`), 60);

function cksum(s) {
  let n = 0;
  for (const c of s) n = (n + c.charCodeAt(0)) & 0xff;
  return n.toString(16).padStart(2, "0");
}
const pkt = (d) => `$${d}#${cksum(d)}`;

async function driveClient() {
  await delay(400);
  const sock = net.createConnection({ port: PORT, host: "127.0.0.1" });
  let buf = "";
  const responses = [];
  const script = ["QStartNoAckMode", "qSupported:xmlRegisters=i386", "?", "c", "qWasmLocal:0;0"];
  let i = 0;
  const send = () => {
    sock.write("+");
    sock.write(pkt(script[i]));
  };
  sock.on("connect", () => {
    sock.write("+");
    send();
  });
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    let h;
    while ((h = buf.indexOf("#")) !== -1 && buf.length >= h + 3) {
      let pl = buf.slice(0, h);
      while (pl[0] === "+" || pl[0] === "-" || pl[0] === "$") pl = pl.slice(1);
      buf = buf.slice(h + 3);
      responses.push(`${script[i]} -> ${pl.slice(0, 40)}`);
      i++;
      if (i < script.length) send();
      else {
        console.log("\n=== exchange ===");
        for (const r of responses) console.log(r);
        const local = responses.find((r) => r.startsWith("qWasmLocal"));
        const cont = responses.find((r) => r.startsWith("c "));
        console.log(`\ncontinue->stop: ${/T05/.test(cont || "") ? "OK" : "FAIL"} (${cont})`);
        console.log(`async read:     ${/efbeadde/.test(local || "") ? "OK" : "FAIL"} (${local})`);
        clearInterval(hb);
        worker.terminate();
        setTimeout(() => process.exit(0), 50);
      }
    }
  });
  sock.on("error", (e) => console.error("[main] sock error", e.message));
}

setTimeout(() => {
  console.error("timeout");
  clearInterval(hb);
  worker.terminate();
  process.exit(1);
}, 15000);
