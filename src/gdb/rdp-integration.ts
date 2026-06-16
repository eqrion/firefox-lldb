// Full-pipeline test: live Firefox (RDP) -> RdpWasmSession -> RdpDebuggee ->
// gdbstub component (worker) -> raw GDB client. Verifies the wasm call stack and
// module bytes served to a GDB client originate from the live browser.
//
// Run with Node >=24: node --experimental-wasm-jspi --import tsx rdp-integration.ts
import net from "node:net";
import { RdpWasmSession } from "../rdp/session.js";
import { RdpDebuggee } from "./rdp-debuggee.js";
// @ts-expect-error - .mjs host has no types
import { startGdbServer } from "./worker/host.mjs";

const RDP_PORT = Number(process.argv[2] ?? 6080);
const PAGE = process.argv[3] ?? "http://localhost:8080/index.html";
const LLDB_PORT = 8780;

const session = await RdpWasmSession.start(RDP_PORT);
await session.navigate("about:blank");
await session.navigate(PAGE);
console.log("[rdp] on", session.targetUrl);

// Pre-pause inside wasm: breakpoint at every position, then call the export.
let wasm = (await session.wasmSources())[0];
for (let i = 0; i < 40 && !wasm; i++) {
  await new Promise((r) => setTimeout(r, 100));
  wasm = (await session.wasmSources())[0];
}
if (!wasm) throw new Error("no wasm source appeared");
const offsets = await session.wasmBreakpointOffsets(wasm.actor);
const paused = new Promise<void>((r) => session.once("paused", () => r()));
for (const off of offsets) await session.setWasmBreakpoint(wasm.url, off);
await session.evaluate("runFactorial()");
await Promise.race([paused, new Promise((r) => setTimeout(r, 4000))]);
const frames = await session.frames();
console.log("[rdp] paused; wasm frame pc offset:", frames.find((f) => f.type === "wasmcall")?.where?.line);

// Serve the gdbstub component backed by the live RDP debuggee.
const debuggee = new RdpDebuggee(session);
const { ready, stop } = startGdbServer({
  dispatch: (req: any) => debuggee.dispatch(req),
  port: LLDB_PORT,
  onInfo: (m: string) => console.log("[component]", m),
});
await ready;

// "hold" mode: keep serving (paused in wasm) so an external LLDB can attach.
if (process.argv.includes("hold")) {
  console.log(`\nHOLDING. Attach: process connect --plugin wasm connect://127.0.0.1:${LLDB_PORT}`);
  await new Promise(() => {}); // never resolves
}

// --- raw GDB client ---
function cksum(s: string) { let n = 0; for (const c of s) n = (n + c.charCodeAt(0)) & 0xff; return n.toString(16).padStart(2, "0"); }
const pkt = (d: string) => `$${d}#${cksum(d)}`;
const sock = net.createConnection({ port: LLDB_PORT, host: "127.0.0.1" });
let buf = "";
const waiters: ((s: string) => void)[] = [];
sock.on("data", (d) => {
  buf += d.toString("latin1");
  let h: number;
  while ((h = buf.indexOf("#")) !== -1 && buf.length >= h + 3) {
    let pl = buf.slice(0, h);
    while (pl[0] === "+" || pl[0] === "-" || pl[0] === "$") pl = pl.slice(1);
    buf = buf.slice(h + 3);
    waiters.shift()?.(pl);
  }
});
// GDB run-length decoding: `X*N` => X repeated (N-29) extra times.
function rle(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "*") { out += out[out.length - 1].repeat(s.charCodeAt(++i) - 29); }
    else out += s[i];
  }
  return out;
}
const req = (d: string) => new Promise<string>((res) => { waiters.push((s) => res(rle(s))); sock.write("+"); sock.write(pkt(d)); });
await new Promise<void>((r) => sock.on("connect", () => r()));

const decodeAddr = (leHex: string) => {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(parseInt(leHex.substr(i * 2, 2), 16)) << BigInt(i * 8);
  return { type: Number((v >> 62n) & 0x3n), moduleId: Number((v >> 32n) & 0x3fffffffn), offset: Number(v & 0xffffffffn) };
};

console.log("\n=== GDB client over RDP ===");
console.log("QStartNoAckMode ->", await req("QStartNoAckMode"));
console.log("qSupported      ->", (await req("qSupported:xmlRegisters=i386")).slice(0, 60));
console.log("?               ->", await req("?"));
const libs = await req("qXfer:libraries:read::0,1000");
console.log("libraries       ->", libs.slice(0, 120));
const callstack = await req("qWasmCallStack:1");
console.log("qWasmCallStack  ->", callstack);
if (callstack && callstack !== "" && !callstack.startsWith("E")) {
  const top = decodeAddr(callstack.slice(0, 16));
  console.log(`  top PC: type=${top.type} module=${top.moduleId} offset=${top.offset}`);
  // Read the module's first bytes via an Object-type address (type=1, offset 0).
  const loadAddr = (BigInt(1) << 62n) | (BigInt(top.moduleId) << 32n);
  const mem = await req(`m${loadAddr.toString(16)},4`);
  console.log(`  module bytes  -> ${mem}  ${mem === "0061736d" ? "(wasm magic \\0asm from live Firefox!)" : ""}`);
}

// Locals (RDP environment bindings) and globals (instance scope) -> WasmValue.
const decodeI32 = (h: string) => { let v = 0; for (let i = 0; i < 4 && i * 2 + 1 < h.length; i++) v |= parseInt(h.substr(i * 2, 2), 16) << (i * 8); return v >>> 0; };
const local0 = await req("qWasmLocal:0;0");
console.log(`qWasmLocal:0;0  -> ${local0}${local0 && !local0.startsWith("E") ? ` (i32=${decodeI32(local0)})` : ""}`);
const global0 = await req("qWasmGlobal:0;0");
console.log(`qWasmGlobal:0;0 -> ${global0}${global0 && !global0.startsWith("E") ? ` (i32=${decodeI32(global0)})` : ""}`);

sock.end();
stop();
session.close();
process.exit(0);
